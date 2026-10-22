import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  coveredLines,
  covers,
  diffCommits,
  isSourceFile,
  overlapsSpan,
  type DiffResult,
} from "../../../src/analysis/diff.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openCase(name: string): Promise<FixtureRepo> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);
  return repo;
}

async function diffCase(name: string): Promise<DiffResult> {
  const repo = await openCase(name);
  return diffCommits(repo.path, repo.baseSha, repo.headSha);
}

describe("changed file listing", () => {
  it(
    "reports a modified source file with its hunks",
    async () => {
      const result = await diffCase("seed-comment-change");

      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.path).toBe("src/calc.ts");
      expect(result.files[0]?.change).toBe("modified");
      expect(result.files[0]?.hunks.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "reports files that changed on only one side with the right status",
    async () => {
      // The fixture replaces one function with another in the same file, so the file is
      // modified even though callables were added and deleted. File status and callable
      // status are different questions; this is the file one.
      const result = await diffCase("seed-added-deleted");

      expect(result.files.map((file) => [file.path, file.change])).toEqual([
        ["src/api.ts", "modified"],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "sorts files by path so the result does not depend on Git's ordering",
    async () => {
      const result = await diffCase("seed-unmapped-change");

      const paths = result.files.map((file) => file.path);
      expect(paths).toEqual([...paths].sort());
    },
    TIMEOUT_MS,
  );

  it(
    "counts non-source files instead of listing them",
    async () => {
      // package.json differs between the two snapshots of this fixture, so there is a
      // real non-source change to account for.
      const result = await diffCase("manifest-changed");

      expect(result.ignoredFileCount).toBe(1);
      expect(result.files.every((file) => isSourceFile(file.path))).toBe(true);
      expect(result.files.map((file) => file.path)).not.toContain(
        "package.json",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "still reports a file whose only change is formatting",
    async () => {
      // Whitespace is a real textual change, so it belongs in the diff. Deciding it is
      // not a seed is T2.3's job, and this records where the boundary sits.
      const result = await diffCase("seed-whitespace-only");

      expect(result.files.map((file) => file.path)).toEqual(["src/calc.ts"]);
      expect(result.files[0]?.hunks.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

describe("renames", () => {
  /** Builds a throwaway case outside tests/fixtures, which is frozen. */
  async function writeCase(files: {
    base: Record<string, string>;
    head: Record<string, string>;
  }): Promise<string> {
    const caseDir = await mkdtemp(join(tmpdir(), "nidan-diff-case-"));
    cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
    for (const [snapshot, entries] of Object.entries(files)) {
      for (const [path, contents] of Object.entries(entries)) {
        const absolute = join(caseDir, snapshot, path);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, contents);
      }
    }
    return caseDir;
  }

  it(
    "reports a moved file as a deletion plus an addition, not a rename",
    async () => {
      const body =
        "export function formatRow(value: string): string {\n  return value.trim();\n}\n";
      const caseDir = await writeCase({
        base: { "src/old.ts": body },
        head: { "src/new.ts": body },
      });
      const repo = await createFixtureRepo(caseDir);
      cleanups.push(repo.cleanup);

      const result = await diffCommits(repo.path, repo.baseSha, repo.headSha);

      // Identical content at a different path is exactly what Git's rename detection
      // would collapse into one entry. nidan must not let it: the path is part of a
      // callable's structural key, so a rename cannot be matched and is a documented
      // limitation. A collapsed rename would promise a match the identity model cannot
      // honour.
      expect(
        result.files.map((file) => [file.path, file.change]).sort(),
      ).toEqual([
        ["src/new.ts", "added"],
        ["src/old.ts", "deleted"],
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("hunk ranges", () => {
  it(
    "maps a one-line edit to the line it changed",
    async () => {
      const result = await diffCase("seed-comment-change");
      const [hunk] = result.files[0]?.hunks ?? [];

      // The JSDoc is line 1 in both snapshots.
      expect(hunk?.base).toEqual({ start: 1, count: 1 });
      expect(hunk?.head).toEqual({ start: 1, count: 1 });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps the position of a pure insertion, where one side has no lines",
    async () => {
      const result = await diffCase("seed-unmapped-change");
      const file = result.files.find(
        (candidate) => candidate.path === "src/types.ts",
      );
      const insertion = file?.hunks.find((hunk) => hunk.base.count === 0);

      // `timeoutMs` is added, so base contributes no lines. The hunk must survive with
      // its position: a zero-count side is where the change happened, not an absence.
      expect(insertion).toBeDefined();
      expect(insertion?.head.count).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "reports every hunk, with both complete ranges",
    async () => {
      // Separated edits, asserted exactly. The previous version of this test required
      // only "at least one hunk with positive starts", which an implementation that
      // returned just the first hunk would have satisfied.
      const caseDir = await mkdtemp(join(tmpdir(), "nidan-diff-case-"));
      cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
      const lines = (first: string, last: string): string =>
        [
          `export const first = ${first};`,
          "const a = 1;",
          "const b = 2;",
          "const c = 3;",
          "const d = 4;",
          `export const last = ${last};`,
        ].join("\n") + "\n";
      for (const [snapshot, text] of [
        ["base", lines("1", "1")],
        ["head", lines("2", "2")],
      ] as const) {
        await mkdir(join(caseDir, snapshot, "src"), { recursive: true });
        await writeFile(join(caseDir, snapshot, "src", "a.ts"), text);
      }
      const repo = await createFixtureRepo(caseDir);
      cleanups.push(repo.cleanup);

      const result = await diffCommits(repo.path, repo.baseSha, repo.headSha);

      expect(result.files[0]?.hunks).toEqual([
        { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
        { base: { start: 6, count: 1 }, head: { start: 6, count: 1 } },
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("range helpers", () => {
  it("expands a range to the lines it covers", () => {
    expect(coveredLines({ start: 4, count: 3 })).toEqual([4, 5, 6]);
    expect(coveredLines({ start: 4, count: 0 })).toEqual([]);
  });

  it("decides whether a line is inside a range", () => {
    expect(covers({ start: 4, count: 2 }, 4)).toBe(true);
    expect(covers({ start: 4, count: 2 }, 5)).toBe(true);
    expect(covers({ start: 4, count: 2 }, 6)).toBe(false);
    expect(covers({ start: 4, count: 0 }, 4)).toBe(false);
  });

  it("overlaps a span when any line is shared", () => {
    expect(overlapsSpan({ start: 5, count: 2 }, 1, 4)).toBe(false);
    expect(overlapsSpan({ start: 5, count: 2 }, 6, 20)).toBe(true);
    expect(overlapsSpan({ start: 5, count: 2 }, 1, 5)).toBe(true);
    expect(overlapsSpan({ start: 5, count: 2 }, 1, 100)).toBe(true);
  });

  it("treats an insertion point as touching the span it sits in", () => {
    // An insertion after line 5 changed any callable spanning lines 5 or 6. Treating a
    // zero-count range as empty would silently drop every pure insertion.
    expect(overlapsSpan({ start: 5, count: 0 }, 1, 4)).toBe(false);
    expect(overlapsSpan({ start: 5, count: 0 }, 5, 10)).toBe(true);
    expect(overlapsSpan({ start: 5, count: 0 }, 6, 10)).toBe(true);
    expect(overlapsSpan({ start: 5, count: 0 }, 7, 10)).toBe(false);
  });

  it("recognizes the four analyzed extensions and nothing else", () => {
    for (const path of ["a.ts", "a.tsx", "a.js", "a.jsx", "deep/nest/a.ts"]) {
      expect(isSourceFile(path)).toBe(true);
    }
    // `.mts` and `.cts` are excluded deliberately: the documented set is the four
    // extensions above, and widening it is a public-contract change.
    for (const path of [
      "a.json",
      "a.md",
      "a.mts",
      "a.cts",
      "a.d.ts.map",
      "tsconfig.json",
    ]) {
      expect(isSourceFile(path)).toBe(false);
    }
  });
});
