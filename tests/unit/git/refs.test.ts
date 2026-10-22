import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitError } from "../../../src/git/errors.js";
import {
  findMergeBase,
  findRepositoryRoot,
  resolveCommit,
} from "../../../src/git/refs.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 30_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Reverse order, one at a time: a blob reader keeps a Git process alive inside the
  // repository, and Windows refuses to remove a directory a live process is using.
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function repoWith(
  base: Record<string, string>,
  head: Record<string, string>,
): Promise<FixtureRepo> {
  const caseDir = await mkdtemp(join(tmpdir(), "nidan-case-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  for (const [snapshot, files] of [
    ["base", base],
    ["head", head],
  ] as const) {
    await mkdir(join(caseDir, snapshot));
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(join(caseDir, snapshot, path), contents);
    }
  }
  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  return repo;
}

describe("findRepositoryRoot", () => {
  it(
    "resolves the root of a repository",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      const root = await findRepositoryRoot(repo.path);

      // macOS reports /private/var for /var, so compare the basename rather than the path.
      expect(root.endsWith("repo")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "reports a directory that is not a repository",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "nidan-outside-"));
      cleanups.push(() => rm(outside, { recursive: true, force: true }));

      await expect(findRepositoryRoot(outside)).rejects.toMatchObject({
        name: "GitError",
        kind: "not-a-repository",
      });
    },
    TIMEOUT_MS,
  );
});

describe("resolveCommit", () => {
  it(
    "resolves a branch to its commit SHA",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      expect(await resolveCommit(repo.path, repo.baseRef)).toBe(repo.baseSha);
      expect(await resolveCommit(repo.path, repo.headRef)).toBe(repo.headSha);
    },
    TIMEOUT_MS,
  );

  it(
    "resolves a full SHA to itself",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      expect(await resolveCommit(repo.path, repo.headSha)).toBe(repo.headSha);
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a ref that does not exist",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      await expect(
        resolveCommit(repo.path, "no-such-ref"),
      ).rejects.toMatchObject({
        kind: "unknown-ref",
      });
    },
    TIMEOUT_MS,
  );

  it.each([
    ["an option-like ref", "--upload-pack=touch /tmp/pwned"],
    ["a short option", "-n"],
    ["an empty ref", ""],
    ["a ref containing a newline", "main\nrm -rf /"],
  ])(
    "rejects %s before invoking git",
    async (_label, ref) => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      await expect(resolveCommit(repo.path, ref)).rejects.toMatchObject({
        kind: "invalid-ref",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "raises a typed error rather than a bare failure",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      await expect(resolveCommit(repo.path, "-x")).rejects.toBeInstanceOf(
        GitError,
      );
    },
    TIMEOUT_MS,
  );
});

describe("findMergeBase", () => {
  it(
    "returns the base commit for a linear history",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      expect(await findMergeBase(repo.path, repo.baseSha, repo.headSha)).toBe(
        repo.baseSha,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "is order independent",
    async () => {
      const repo = await repoWith({ "a.ts": "1\n" }, { "a.ts": "2\n" });

      const forward = await findMergeBase(
        repo.path,
        repo.baseSha,
        repo.headSha,
      );
      const reverse = await findMergeBase(
        repo.path,
        repo.headSha,
        repo.baseSha,
      );
      expect(reverse).toBe(forward);
    },
    TIMEOUT_MS,
  );
});
