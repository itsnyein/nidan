import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openBlobReader } from "../../../src/git/blobs.js";
import {
  FILE_MODE,
  isSymlink,
  listTree,
  type TreeEntry,
} from "../../../src/git/tree.js";
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

interface CaseFiles {
  readonly base: Record<string, string>;
  readonly head: Record<string, string>;
}

async function repoWith(
  files: CaseFiles,
  extra?: (caseDir: string) => Promise<void>,
): Promise<FixtureRepo> {
  const caseDir = await mkdtemp(join(tmpdir(), "omen-case-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  for (const [snapshot, entries] of [
    ["base", files.base],
    ["head", files.head],
  ] as const) {
    await mkdir(join(caseDir, snapshot), { recursive: true });
    for (const [path, contents] of Object.entries(entries)) {
      const absolute = join(caseDir, snapshot, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents);
    }
  }
  await extra?.(caseDir);
  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  return repo;
}

function pathsOf(entries: readonly TreeEntry[]): string[] {
  return entries.map((entry) => entry.path).sort();
}

describe("listTree", () => {
  it(
    "lists every file reachable from a commit, recursively",
    async () => {
      const repo = await repoWith({
        base: { "a.ts": "1\n", "nested/b.ts": "2\n" },
        head: { "a.ts": "1\n", "nested/b.ts": "3\n" },
      });

      const entries = await listTree(repo.path, repo.headSha);

      expect(pathsOf(entries)).toEqual(["a.ts", "nested/b.ts"]);
      expect(entries.every((entry) => entry.type === "blob")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "uses POSIX paths and does not list directories",
    async () => {
      const repo = await repoWith({
        base: { "deep/nest/c.ts": "1\n" },
        head: { "deep/nest/c.ts": "2\n" },
      });

      const entries = await listTree(repo.path, repo.headSha);

      expect(pathsOf(entries)).toEqual(["deep/nest/c.ts"]);
      expect(entries.some((entry) => entry.type === "tree")).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "reflects the commit it was asked about, not the latest one",
    async () => {
      const repo = await repoWith({
        base: { "only-in-base.ts": "1\n" },
        head: { "only-in-head.ts": "2\n" },
      });

      expect(pathsOf(await listTree(repo.path, repo.baseSha))).toEqual([
        "only-in-base.ts",
      ]);
      expect(pathsOf(await listTree(repo.path, repo.headSha))).toEqual([
        "only-in-head.ts",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "handles a path containing a space",
    async () => {
      const repo = await repoWith({
        base: { "a file.ts": "1\n" },
        head: { "a file.ts": "2\n" },
      });

      expect(pathsOf(await listTree(repo.path, repo.headSha))).toEqual([
        "a file.ts",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "reports a symlink with its mode rather than following it",
    async () => {
      const repo = await repoWith(
        { base: { "target.ts": "1\n" }, head: { "target.ts": "1\n" } },
        async (caseDir) => {
          for (const snapshot of ["base", "head"]) {
            await symlink("target.ts", join(caseDir, snapshot, "link.ts"));
          }
        },
      );

      const entries = await listTree(repo.path, repo.headSha);
      const link = entries.find((entry) => entry.path === "link.ts");

      expect(link?.mode).toBe(FILE_MODE.symlink);
      expect(link === undefined ? false : isSymlink(link)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("openBlobReader", () => {
  it(
    "reads blob contents exactly as stored",
    async () => {
      const repo = await repoWith({
        base: { "a.ts": "export const a = 1;\n" },
        head: { "a.ts": "export const a = 2;\n" },
      });
      const entries = await listTree(repo.path, repo.baseSha);
      const entry = entries.find((candidate) => candidate.path === "a.ts");
      expect(entry).toBeDefined();

      const reader = openBlobReader(repo.path);
      cleanups.push(() => reader.close());

      const contents = await reader.read(entry?.oid ?? "");
      expect(contents.toString("utf8")).toBe("export const a = 1;\n");
    },
    TIMEOUT_MS,
  );

  it(
    "answers many concurrent reads, each with its own content",
    async () => {
      const base: Record<string, string> = {};
      for (let index = 0; index < 25; index += 1) {
        base[`file-${String(index)}.ts`] =
          `export const value = ${String(index)};\n`;
      }
      const repo = await repoWith({ base, head: base });
      const entries = await listTree(repo.path, repo.baseSha);

      const reader = openBlobReader(repo.path);
      cleanups.push(() => reader.close());

      const contents = await Promise.all(
        entries.map(async (entry) => ({
          path: entry.path,
          text: (await reader.read(entry.oid)).toString("utf8"),
        })),
      );

      for (const { path, text } of contents) {
        const index = /file-(\d+)\.ts/.exec(path)?.[1];
        expect(text).toBe(`export const value = ${index ?? ""};\n`);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "preserves CRLF rather than normalizing it",
    async () => {
      // Normalization belongs to the snapshot layer; this layer must hand back bytes.
      const repo = await repoWith({
        base: { "a.ts": "line\r\nnext\r\n" },
        head: { "a.ts": "line\r\nnext\r\n" },
      });
      const entries = await listTree(repo.path, repo.baseSha);
      const reader = openBlobReader(repo.path);
      cleanups.push(() => reader.close());

      const contents = await reader.read(entries[0]?.oid ?? "");
      expect(contents.toString("utf8")).toBe("line\r\nnext\r\n");
    },
    TIMEOUT_MS,
  );

  it(
    "reports a missing object without killing the reader",
    async () => {
      const repo = await repoWith({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });
      const reader = openBlobReader(repo.path);
      cleanups.push(() => reader.close());

      const absent = "0".repeat(40);
      await expect(reader.read(absent)).rejects.toMatchObject({
        kind: "missing-object",
      });

      const entries = await listTree(repo.path, repo.baseSha);
      const contents = await reader.read(entries[0]?.oid ?? "");
      expect(contents.toString("utf8")).toBe("1\n");
    },
    TIMEOUT_MS,
  );

  it(
    "ignores an inherited GIT_DIR rather than reading another repository",
    async () => {
      const repo = await repoWith({
        base: { "a.ts": "export const a = 1;\n" },
        head: { "a.ts": "export const a = 2;\n" },
      });
      const entries = await listTree(repo.path, repo.baseSha);

      // cat-file is spawned rather than run through the shared helper, so it has to take
      // the scrubbed environment explicitly. Without it, GIT_DIR points this at a
      // different object store entirely.
      process.env["GIT_DIR"] = join(repo.path, "..", "not-a-repo");
      try {
        const reader = openBlobReader(repo.path);
        cleanups.push(() => reader.close());
        const contents = await reader.read(entries[0]?.oid ?? "");
        expect(contents.toString("utf8")).toBe("export const a = 1;\n");
      } finally {
        delete process.env["GIT_DIR"];
      }
    },
    TIMEOUT_MS,
  );

  it(
    "closes idempotently and refuses reads afterwards",
    async () => {
      const repo = await repoWith({
        base: { "a.ts": "1\n" },
        head: { "a.ts": "2\n" },
      });
      const reader = openBlobReader(repo.path);

      await reader.close();
      await expect(reader.close()).resolves.toBeUndefined();
      await expect(reader.read("0".repeat(40))).rejects.toThrow(/closed/);
    },
    TIMEOUT_MS,
  );
});
