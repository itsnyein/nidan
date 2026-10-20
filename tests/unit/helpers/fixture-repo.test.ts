import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
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
}): Promise<string> {
  const caseDir = await tempDir();
  await writeFile(join(caseDir, "expected.json"), '{"seeds":[]}\n');
  await writeFile(join(caseDir, "README.md"), "# case\n");

  for (const [snapshot, entries] of Object.entries(files)) {
    await mkdir(join(caseDir, snapshot));
    for (const [relativePath, contents] of Object.entries(entries)) {
      await writeFile(join(caseDir, snapshot, relativePath), contents);
    }
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
