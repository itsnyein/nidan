import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureRepo,
  FixtureRepoError,
} from "../../helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Registers a temporary directory for removal after the current test. */
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omen-case-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * Writes a fixture case directory. Keys are repo-relative paths under `base/` or `head/`;
 * `expected.json` and `README.md` are written at the case root, as real cases have them.
 */
async function writeCase(files: {
  base: Record<string, string>;
  head: Record<string, string>;
  node_modules?: Record<string, string>;
  worktree?: Record<string, string>;
  links?: { links: Array<{ path: string; target: string }> };
}): Promise<string> {
  const caseDir = await tempDir();
  await writeFile(join(caseDir, "expected.json"), '{"seeds":[]}\n');
  await writeFile(join(caseDir, "README.md"), "# case\n");

  const { links, ...directories } = files;
  for (const [directory, entries] of Object.entries(directories)) {
    for (const [relativePath, contents] of Object.entries(entries)) {
      const absolute = join(caseDir, directory, relativePath);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents);
    }
  }
  if (links !== undefined) {
    await writeFile(join(caseDir, "links.json"), JSON.stringify(links));
  }
  return caseDir;
}

async function build(caseDir: string): ReturnType<typeof createFixtureRepo> {
  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  return repo;
}

/**
 * Inspects a repository built by the harness. Inherited `GIT_*` variables are stripped
 * for the same reason the harness strips them: the isolation test deliberately sets
 * `GIT_DIR`, and without this the inspection would read that decoy instead of the
 * repository under test.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout.trim();
}

/** Git operations on the Windows CI runner routinely exceed vitest's 5s default. */
const TIMEOUT_MS = 30_000;

/** Paths tracked at a ref, one per line. */
async function filesAt(repoPath: string, ref: string): Promise<string[]> {
  const output = await git(["ls-tree", "-r", "--name-only", ref], repoPath);
  return output === "" ? [] : output.split("\n").sort();
}

/** Mode, type, blob SHA, size, and path for every tracked file at a ref. */
async function treeAt(repoPath: string, ref: string): Promise<string> {
  return git(["ls-tree", "-r", "--long", ref], repoPath);
}

async function fileAt(
  repoPath: string,
  ref: string,
  path: string,
): Promise<string> {
  return git(["show", `${ref}:${path}`], repoPath);
}

/** Author, committer, timestamps, and tree hash — everything a commit SHA covers. */
async function commitMetadata(repoPath: string, ref: string): Promise<string> {
  return git(
    ["log", "--format=%an|%ae|%at|%cn|%ce|%ct|%T", "-1", ref],
    repoPath,
  );
}

describe("createFixtureRepo", () => {
  it(
    "commits base/ at the base ref and head/ at the head ref",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "export const a = 1;\n" },
        head: { "a.ts": "export const a = 2;\n" },
      });

      const repo = await build(caseDir);

      expect(await filesAt(repo.path, repo.baseRef)).toEqual(["a.ts"]);
      expect(await fileAt(repo.path, repo.baseRef, "a.ts")).toBe(
        "export const a = 1;",
      );
      expect(await fileAt(repo.path, repo.headRef, "a.ts")).toBe(
        "export const a = 2;",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "re-hashes a file whose length did not change between snapshots",
    async () => {
      // The trigger shape for Git's racy index: identical size, rewritten within the
      // filesystem's mtime granularity. If the index is trusted instead of the content,
      // the head commit silently keeps the base blob.
      const caseDir = await writeCase({
        base: { "a.ts": "export const a = 1;\n" },
        head: { "a.ts": "export const a = 2;\n" },
      });

      const repo = await build(caseDir);

      expect(await fileAt(repo.path, repo.headRef, "a.ts")).toBe(
        "export const a = 2;",
      );
      expect(await treeAt(repo.path, repo.headRef)).not.toBe(
        await treeAt(repo.path, repo.baseRef),
      );
    },
    TIMEOUT_MS,
  );

  it(
    "deletes a file that base has and head does not",
    async () => {
      const caseDir = await writeCase({
        base: {
          "kept.ts": "export const kept = 1;\n",
          "gone.ts": "export const gone = 1;\n",
        },
        head: { "kept.ts": "export const kept = 1;\n" },
      });

      const repo = await build(caseDir);

      expect(await filesAt(repo.path, repo.baseRef)).toEqual([
        "gone.ts",
        "kept.ts",
      ]);
      expect(await filesAt(repo.path, repo.headRef)).toEqual(["kept.ts"]);
    },
    TIMEOUT_MS,
  );

  it(
    "never commits the case metadata files",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });

      const repo = await build(caseDir);

      for (const ref of [repo.baseRef, repo.headRef]) {
        const files = await filesAt(repo.path, ref);
        expect(files).not.toContain("expected.json");
        expect(files).not.toContain("README.md");
      }
    },
    TIMEOUT_MS,
  );

  it(
    "makes the base commit the merge-base of the two refs",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });

      const repo = await build(caseDir);

      const mergeBase = await git(
        ["merge-base", repo.baseRef, repo.headRef],
        repo.path,
      );
      expect(mergeBase).toBe(repo.baseSha);
      expect(repo.headSha).not.toBe(repo.baseSha);
    },
    TIMEOUT_MS,
  );

  it(
    "produces identical SHAs when the same case is built twice",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });

      const first = await build(caseDir);
      const second = await build(caseDir);

      // Trees are compared before SHAs so a failure shows which blob, mode, or size
      // diverged rather than only that two hashes differ.
      expect(await treeAt(second.path, second.baseRef)).toBe(
        await treeAt(first.path, first.baseRef),
      );
      expect(await treeAt(second.path, second.headRef)).toBe(
        await treeAt(first.path, first.headRef),
      );
      expect(second.baseSha).toBe(first.baseSha);
      expect(second.headSha).toBe(first.headSha);
      expect(first.path).not.toBe(second.path);
    },
    TIMEOUT_MS,
  );

  it(
    "commits with the fixed identity and date, not the machine's",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });

      const repo = await build(caseDir);

      // %at/%ct rather than %aI/%cI: the Unix timestamp renders identically across Git
      // versions, where the ISO form varies between "Z" and "+00:00".
      const identity = await git(
        ["log", "--format=%an|%ae|%at|%cn|%ce|%ct", "-1", repo.headRef],
        repo.path,
      );
      const epochOf2000 = "946684800";
      expect(identity).toBe(
        `omen fixtures|fixtures@omen.invalid|${epochOf2000}|` +
          `omen fixtures|fixtures@omen.invalid|${epochOf2000}`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "ignores inherited GIT_* variables",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });
      const expected = await build(caseDir);

      const decoy = await tempDir();
      process.env["GIT_DIR"] = join(decoy, "not-a-repo");
      process.env["GIT_AUTHOR_NAME"] = "leaked";
      process.env["GIT_AUTHOR_DATE"] = "2024-06-01T12:00:00Z";
      try {
        const repo = await build(caseDir);
        // Commit metadata is compared before the SHA so a failure names the field that
        // leaked rather than only reporting two different hashes.
        expect(await commitMetadata(repo.path, repo.headRef)).toBe(
          await commitMetadata(expected.path, expected.headRef),
        );
        expect(repo.baseSha).toBe(expected.baseSha);
        expect(repo.headSha).toBe(expected.headSha);
      } finally {
        delete process.env["GIT_DIR"];
        delete process.env["GIT_AUTHOR_NAME"];
        delete process.env["GIT_AUTHOR_DATE"];
      }
    },
    TIMEOUT_MS,
  );

  it(
    "copies node_modules into the work tree without committing it",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
        node_modules: { "left-pad/package.json": '{"name":"left-pad"}\n' },
      });

      const repo = await build(caseDir);

      expect(
        await readFile(
          join(repo.path, "node_modules", "left-pad", "package.json"),
          "utf8",
        ),
      ).toBe('{"name":"left-pad"}\n');
      // Absent from both commits: dependencies are read from disk, never from a snapshot.
      for (const ref of [repo.baseRef, repo.headRef]) {
        const files = await filesAt(repo.path, ref);
        expect(files.some((file) => file.startsWith("node_modules/"))).toBe(
          false,
        );
      }
    },
    TIMEOUT_MS,
  );

  it(
    "overlays the work tree so it disagrees with head",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
        worktree: { "a.ts": "3\n", "untracked.ts": "4\n" },
      });

      const repo = await build(caseDir);

      // On disk the overlay wins...
      expect(await readFile(join(repo.path, "a.ts"), "utf8")).toBe("3\n");
      // ...while head keeps its own content and never gains the untracked file.
      expect(await fileAt(repo.path, repo.headRef, "a.ts")).toBe("2");
      expect(await filesAt(repo.path, repo.headRef)).toEqual(["a.ts"]);
    },
    TIMEOUT_MS,
  );

  it(
    "really does leave the work tree disagreeing with head",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
        worktree: { "a.ts": "3\n", "untracked.ts": "4\n" },
      });

      const repo = await build(caseDir);

      // A leak fixture is only meaningful if the work tree really is dirty, so assert it
      // rather than assuming the overlay did something.
      //
      // Compared against the committed blob rather than `git status`: `a.ts` is the same
      // size in head and in the overlay, and Git's index trusts stat data, so on a
      // filesystem with coarse mtime resolution status can report the file as clean. That
      // is a Git-index artifact and not something omen depends on — omen reads sources
      // from Git objects and never consults the work tree — but the disk content must
      // genuinely differ or the leak case proves nothing.
      const onDisk = await readFile(join(repo.path, "a.ts"), "utf8");
      const inHead = await fileAt(repo.path, repo.headRef, "a.ts");
      expect(onDisk.trim()).not.toBe(inHead.trim());
      expect(onDisk).toBe("3\n");

      // The untracked file has no index entry at all, so Git reports it reliably.
      const status = await git(["status", "--porcelain"], repo.path);
      expect(status).toContain("untracked.ts");
    },
    TIMEOUT_MS,
  );

  it(
    "creates directory links described by links.json",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
        node_modules: {
          ".pnpm/ms@2.1.3/node_modules/ms/package.json": '{"name":"ms"}\n',
        },
        links: {
          links: [
            {
              path: "node_modules/ms",
              target: "node_modules/.pnpm/ms@2.1.3/node_modules/ms",
            },
          ],
        },
      });

      const repo = await build(caseDir);

      // Reading through the link is what a pnpm layout requires of module resolution.
      expect(
        await readFile(
          join(repo.path, "node_modules", "ms", "package.json"),
          "utf8",
        ),
      ).toBe('{"name":"ms"}\n');
      const resolved = await realpath(join(repo.path, "node_modules", "ms"));
      expect(resolved).toContain(".pnpm");
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a links.json entry whose target is not a directory",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
        links: { links: [{ path: "node_modules/ms", target: "nowhere" }] },
      });

      await expect(createFixtureRepo(caseDir)).rejects.toThrow(
        /not a directory/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a malformed links.json",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });
      await writeFile(join(caseDir, "links.json"), "{ not json");

      await expect(createFixtureRepo(caseDir)).rejects.toThrow(
        /not valid JSON/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "removes the temporary directory on cleanup",
    async () => {
      const caseDir = await writeCase({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });
      const repo = await createFixtureRepo(caseDir);

      await repo.cleanup();

      await expect(access(repo.path)).rejects.toThrow();
      await expect(repo.cleanup()).resolves.toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "reports a missing snapshot directory, naming the case and the directory",
    async () => {
      const caseDir = await tempDir();
      await mkdir(join(caseDir, "base"));

      await expect(createFixtureRepo(caseDir)).rejects.toThrow(
        FixtureRepoError,
      );
      await expect(createFixtureRepo(caseDir)).rejects.toThrow(/head/);
      await expect(createFixtureRepo(caseDir)).rejects.toThrow(caseDir);
    },
    TIMEOUT_MS,
  );
});
