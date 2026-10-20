import { execFile } from "node:child_process";
import { mkdtemp, cp, mkdir, rm, readdir, stat } from "node:fs/promises";
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
export async function createFixtureRepo(caseDir: string): Promise<FixtureRepo> {
  const baseDir = join(caseDir, BASE_REF);
  const headDir = join(caseDir, HEAD_REF);
  await assertDirectory(baseDir, caseDir);
  await assertDirectory(headDir, caseDir);

  const root = await mkdtemp(join(tmpdir(), "omen-fixture-"));
  const repoPath = join(root, "repo");
  const homePath = join(root, "home");
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

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

    return {
      path: repoPath,
      baseRef: BASE_REF,
      headRef: HEAD_REF,
      baseSha,
      headSha,
      cleanup,
    };
  } catch (error) {
    // A half-built repository is never handed back, and never left on disk.
    await cleanup();
    throw error;
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
