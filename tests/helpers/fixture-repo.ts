import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Fixed identity and timestamp for every fixture commit. Commit SHAs are derived from
 * these together with the tree and parentage, so pinning them is what makes a fixture
 * repository byte-identical on every machine and every run.
 */
const FIXTURE_AUTHOR = {
  name: "omen fixtures",
  email: "fixtures@omen.invalid",
  date: "2000-01-01T00:00:00Z",
} as const;

const BASE_REF = "base";
const HEAD_REF = "head";

/** Where a template records its commit SHAs, so copies need not re-run `git`. */
const REFS_FILE = "omen-refs.json";

/** Copied into `<repo>/node_modules` after the commits, never committed. */
const NODE_MODULES_DIR = "node_modules";
/** Overlaid onto the work tree after the commits, never committed. */
const WORKTREE_DIR = "worktree";
/** Describes directory symlinks to create in the work tree. See {@link LinkManifest}. */
const LINKS_FILE = "links.json";

interface LinkSpec {
  /** Repository-relative path of the link to create. */
  readonly path: string;
  /** Repository-relative path the link points at. */
  readonly target: string;
}

interface LinkManifest {
  readonly links: readonly LinkSpec[];
}

export class FixtureRepoError extends Error {
  override readonly name = "FixtureRepoError";
}

export interface FixtureRepo {
  /** Absolute path to the temporary repository. */
  readonly path: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Removes the temporary directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Builds a temporary Git repository from a fixture case directory containing `base/` and
 * `head/` subdirectories. The first commit holds `base/`, the second holds `head/`, and
 * they are reachable as the refs `base` and `head`.
 *
 * The caller owns the result and must call `cleanup()`.
 */
/**
 * Built repositories, keyed by case directory, one entry per worker process.
 *
 * Measured before this existed: a full run built **272** repositories at a mean of
 * **4,287 ms** each — 1,166 s of work inside a 257 s wall clock, which is essentially all
 * of the suite's worker time. 146 of those builds came from only ~29 fixture directories,
 * `overlay-basic` alone 31 times.
 *
 * The cached value is a **template**, never handed out directly: each caller gets a fresh
 * copy, so a test can mutate its repository without any other test seeing it. Copying a
 * built tree costs one `cp` instead of `git init`, two recursive copies, two commits and
 * a `branch` — roughly six subprocess spawns.
 *
 * Vitest runs files in separate worker processes, so this is per worker rather than per
 * run. A fixture used by several files is still built once per worker that uses it.
 */
const templates = new Map<string, Promise<string>>();

export async function createFixtureRepo(caseDir: string): Promise<FixtureRepo> {
  const baseDir = join(caseDir, BASE_REF);
  const headDir = join(caseDir, HEAD_REF);
  await assertDirectory(baseDir, caseDir);
  await assertDirectory(headDir, caseDir);

  // A built template is reused across calls for the same case; the caller still gets its
  // own copy. `buildTemplate` is memoised by the promise itself, so concurrent callers in
  // one worker await a single build rather than racing to create several.
  //
  // **Cases with working-tree extras are never templated.** `createLinks` writes symlinks
  // whose targets are absolute paths inside the repository that built them, so a copy
  // relocates the link but not its target — the pnpm-layout cases then resolve to the
  // template's path or to nothing. Two tests caught this after `verbatimSymlinks` fixed
  // the first, coarser version of the same mistake. Relocatable links would mean changing
  // what those fixtures express, which is not this task's to decide.
  if (await hasWorkingTreeExtras(caseDir)) {
    return buildDirect(caseDir, baseDir, headDir);
  }

  let template = templates.get(caseDir);
  if (template === undefined) {
    template = buildTemplate(caseDir, baseDir, headDir);
    templates.set(caseDir, template);
  }
  const templateRoot = await template;

  const root = await mkdtemp(join(tmpdir(), "omen-fixture-"));
  const repoPath = join(root, "repo");
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

  // `verbatimSymlinks` because the default **dereferences** symlinks: the pnpm-layout
  // fixtures build directory symlinks into `node_modules`, and copying them as real
  // directories silently changes what the case tests. Five tests caught this.
  await cp(templateRoot, root, { recursive: true, verbatimSymlinks: true });
  const { baseSha, headSha } = await readRefs(repoPath);
  return {
    path: repoPath,
    baseRef: BASE_REF,
    headRef: HEAD_REF,
    baseSha,
    headSha,
    cleanup,
  };
}

/** Whether a case carries uncommitted content that a template copy cannot relocate. */
async function hasWorkingTreeExtras(caseDir: string): Promise<boolean> {
  if (await isDirectory(join(caseDir, NODE_MODULES_DIR))) return true;
  if (await isDirectory(join(caseDir, WORKTREE_DIR))) return true;
  return existsSync(join(caseDir, LINKS_FILE));
}

/** Builds a repository the caller keeps, for cases a template cannot serve. */
async function buildDirect(
  caseDir: string,
  baseDir: string,
  headDir: string,
): Promise<FixtureRepo> {
  const templateRoot = await buildTemplate(caseDir, baseDir, headDir);
  const repoPath = join(templateRoot, "repo");
  const { baseSha, headSha } = await readRefs(repoPath);
  return {
    path: repoPath,
    baseRef: BASE_REF,
    headRef: HEAD_REF,
    baseSha,
    headSha,
    cleanup: async (): Promise<void> => {
      await rm(templateRoot, { recursive: true, force: true });
    },
  };
}

/** Builds one repository to be copied, not handed out. */
async function buildTemplate(
  caseDir: string,
  baseDir: string,
  headDir: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omen-template-"));
  const repoPath = join(root, "repo");
  const homePath = join(root, "home");

  try {
    await mkdir(repoPath);
    await mkdir(homePath);
    const env = isolatedGitEnv(homePath);

    await git(["init", "--initial-branch", HEAD_REF], repoPath, env);

    await cp(baseDir, repoPath, { recursive: true });
    const baseSha = await commitAll(repoPath, env, "base");

    await clearWorkTree(repoPath);
    await cp(headDir, repoPath, { recursive: true });
    const headSha = await commitAll(repoPath, env, "head");

    // `head` is the checked-out branch, so only `base` needs creating. Both refs exist
    // before the harness returns, which is what callers resolve against.
    await git(["branch", BASE_REF, baseSha], repoPath, env);

    // Everything below lands after the last commit and is never staged, so it exists only
    // in the work tree. That is the point: dependencies are read from disk rather than
    // from a snapshot, and a leak case needs the work tree to disagree with head.
    await applyWorkingTree(caseDir, repoPath);

    // The SHAs are recorded in the template so a copy need not re-run `git`.
    await writeFile(
      join(root, REFS_FILE),
      JSON.stringify({ baseSha, headSha }),
      "utf8",
    );
    return root;
  } catch (error) {
    // A half-built template is never handed back, and never left on disk.
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Reads the SHAs recorded when the template was built. */
async function readRefs(
  repoPath: string,
): Promise<{ baseSha: string; headSha: string }> {
  const raw = await readFile(join(repoPath, "..", REFS_FILE), "utf8");
  // The file is written by `buildTemplate` directly above; its shape is not external
  // input.
  return JSON.parse(raw) as { baseSha: string; headSha: string };
}

/**
 * Applies a case's optional uncommitted content: `node_modules/`, a `worktree/` overlay,
 * and directory symlinks described by `links.json`. Each part is optional, and a case
 * with none of them behaves exactly as it did before.
 */
async function applyWorkingTree(
  caseDir: string,
  repoPath: string,
): Promise<void> {
  if (await isDirectory(join(caseDir, NODE_MODULES_DIR))) {
    await cp(
      join(caseDir, NODE_MODULES_DIR),
      join(repoPath, NODE_MODULES_DIR),
      {
        recursive: true,
      },
    );
  }

  if (await isDirectory(join(caseDir, WORKTREE_DIR))) {
    // Overlay, not replace: `worktree/` names only the files it wants to differ from
    // head, so a case can dirty one file without restating the whole tree.
    await cp(join(caseDir, WORKTREE_DIR), repoPath, {
      recursive: true,
      force: true,
    });
  }

  await createLinks(caseDir, repoPath);
}

/**
 * Creates the directory symlinks a case asks for.
 *
 * Links are described in a manifest rather than committed as symlinks, because Git for
 * Windows checks symlinks out as plain text files by default — a committed pnpm layout
 * would silently become a directory of path strings there. Creating them at test time
 * keeps one representation that works on every platform.
 *
 * Windows gets junctions. A junction points at a directory, needs no elevated privileges,
 * and is what `realpath` resolves through — which is the behavior a pnpm layout exercises.
 * File symlinks are deliberately unsupported: on Windows they require Developer Mode or
 * administrator rights, and no fixture needs them.
 */
async function createLinks(caseDir: string, repoPath: string): Promise<void> {
  const manifestPath = join(caseDir, LINKS_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return;
  }

  const manifest = parseLinkManifest(raw, manifestPath);
  for (const link of manifest.links) {
    const linkPath = join(repoPath, link.path);
    const targetPath = join(repoPath, link.target);
    if (!(await isDirectory(targetPath))) {
      throw new FixtureRepoError(
        `${LINKS_FILE} in "${caseDir}" points "${link.path}" at "${link.target}", which is not a directory`,
      );
    }
    await mkdir(join(linkPath, ".."), { recursive: true });
    await symlink(targetPath, linkPath, "junction");
  }
}

function parseLinkManifest(raw: string, manifestPath: string): LinkManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FixtureRepoError(`${manifestPath} is not valid JSON`, {
      cause: error,
    });
  }

  if (typeof parsed !== "object" || parsed === null || !("links" in parsed)) {
    throw new FixtureRepoError(
      `${manifestPath} must be an object with a "links" array`,
    );
  }
  const { links } = parsed;
  if (!Array.isArray(links)) {
    throw new FixtureRepoError(
      `${manifestPath} must be an object with a "links" array`,
    );
  }

  return {
    links: links.map((entry, index) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { path?: unknown }).path !== "string" ||
        typeof (entry as { target?: unknown }).target !== "string"
      ) {
        throw new FixtureRepoError(
          `${manifestPath} link ${String(index)} needs string "path" and "target" fields`,
        );
      }
      return entry as LinkSpec;
    }),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertDirectory(path: string, caseDir: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(path)).isDirectory();
  } catch (error) {
    throw new FixtureRepoError(
      `fixture case "${caseDir}" is missing the directory ${path}`,
      {
        cause: error,
      },
    );
  }
  if (!isDirectory) {
    throw new FixtureRepoError(
      `fixture case "${caseDir}" has ${path}, but it is not a directory`,
    );
  }
}

/**
 * Builds the environment every Git call runs under.
 *
 * Inherited `GIT_*` variables are dropped rather than overridden: a test run started from
 * a hook or an interactive rebase inherits `GIT_DIR` and `GIT_INDEX_FILE`, which would
 * silently redirect these commands at the *outer* repository.
 */
function isolatedGitEnv(homePath: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );

  return {
    ...inherited,
    // A global config found through HOME would still apply even with GIT_CONFIG_GLOBAL
    // set, because some lookups resolve HOME directly.
    HOME: homePath,
    USERPROFILE: homePath,
    XDG_CONFIG_HOME: join(homePath, ".config"),
    // A path that does not exist, rather than a null device. Git reads a missing config
    // file as empty on every platform, whereas Git for Windows rejects the Windows null
    // device outright: "fatal: unable to access '\\.\nul': Invalid argument".
    GIT_CONFIG_GLOBAL: join(homePath, "absent.gitconfig"),
    GIT_CONFIG_SYSTEM: join(homePath, "absent.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_AUTHOR_DATE: FIXTURE_AUTHOR.date,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_DATE: FIXTURE_AUTHOR.date,
    // Set through the environment so no config file is written into the repository, which
    // would otherwise become part of the committed tree.
    GIT_CONFIG_COUNT: "3",
    // Without this, Git on Windows rewrites LF to CRLF on checkout and the blob hashes,
    // and therefore the commit SHAs, stop matching other platforms.
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: join(homePath, "no-hooks"),
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
  };
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env });
    return stdout.trim();
  } catch (error) {
    throw new FixtureRepoError(`git ${args.join(" ")} failed in ${cwd}`, {
      cause: error,
    });
  }
}

async function commitAll(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  message: string,
): Promise<string> {
  // Emptying the index first forces every file to be hashed from its contents. Without
  // this, `git add` trusts the stat data cached from the previous commit and skips files
  // whose size is unchanged and whose mtime falls inside the filesystem's granularity --
  // Git's "racy index" problem. A fixture that edits a file without changing its length
  // would then silently commit the previous snapshot's content. It reproduces on Windows,
  // whose mtime resolution is coarsest, and is why fixture SHAs were nondeterministic.
  await git(["read-tree", "--empty"], repoPath, env);
  await git(["add", "--all"], repoPath, env);
  // --allow-empty keeps a case whose base and head are identical from failing here; that
  // is a legitimate fixture (a change that must produce no seed).
  await git(["commit", "--allow-empty", "--message", message], repoPath, env);
  return git(["rev-parse", "HEAD"], repoPath, env);
}

/**
 * Empties the work tree so the next commit's tree equals the source directory exactly,
 * which is what makes a file dropped between base and head register as a deletion.
 */
async function clearWorkTree(repoPath: string): Promise<void> {
  const entries = await readdir(repoPath);
  await Promise.all(
    entries
      .filter((entry) => entry !== ".git")
      .map((entry) =>
        rm(join(repoPath, entry), { recursive: true, force: true }),
      ),
  );
}
