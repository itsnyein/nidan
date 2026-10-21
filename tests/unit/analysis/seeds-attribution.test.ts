import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds, type SeedResult } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      allowJs: true,
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  },
  null,
  2,
);

interface Outcome {
  readonly result: SeedResult;
  /** Hunk count taken from the diff itself, independent of the mapper's own counter. */
  readonly hunksInDiff: number;
}

/**
 * Builds a throwaway case outside `tests/fixtures/`, which is frozen, and runs the whole
 * M2 chain over it.
 */
async function run(files: {
  base: Record<string, string>;
  head: Record<string, string>;
}): Promise<Outcome> {
  const caseDir = await mkdtemp(join(tmpdir(), "omen-seeds-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  for (const [snapshot, entries] of Object.entries(files)) {
    await mkdir(join(caseDir, snapshot), { recursive: true });
    await writeFile(join(caseDir, snapshot, "tsconfig.json"), `${TSCONFIG}\n`);
    for (const [path, contents] of Object.entries(entries)) {
      const absolute = join(caseDir, snapshot, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents);
    }
  }

  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  const diff = await diffCommits(repo.path, repo.baseSha, repo.headSha);

  return {
    result: mapSeeds({
      diff,
      base: enumerateCallables(pair.base.project.getSourceFiles(), repo.path),
      head: enumerateCallables(pair.head.project.getSourceFiles(), repo.path),
    }),
    hunksInDiff: diff.files.reduce(
      (total, file) => total + file.hunks.length,
      0,
    ),
  };
}

function seedKeys(result: SeedResult): string[] {
  return result.seeds.map((seed) => `${seed.key} ${seed.change}`).sort();
}

/**
 * Checks the accounting against a hunk total computed from the diff, not from the
 * mapper's own counter. Comparing the mapper's buckets to the mapper's own total is
 * tautological: both derive from the same array.
 */
function expectAccountsForEveryHunk(outcome: Outcome): void {
  const { seedConsumed, formattingFiltered, gapOnly, totalHunks } =
    outcome.result.accounting;

  expect(totalHunks).toBe(outcome.hunksInDiff);
  expect(seedConsumed + formattingFiltered + gapOnly).toBe(outcome.hunksInDiff);
  expect(outcome.hunksInDiff).toBeGreaterThan(0);
}

describe("a hunk covering several callables", () => {
  const THREE = [
    "export function alpha(): number {",
    "  return 1;",
    "}",
    "",
    "export function beta(): number {",
    "  return 2;",
    "}",
    "",
    "export function gamma(): number {",
    "  return 3;",
    "}",
    "",
  ].join("\n");

  it(
    "seeds every callable in an added file, not just one",
    async () => {
      // Git emits an added file as a single hunk covering the whole file. Attributing it
      // to one callable leaves the others neither seeded nor reported.
      const outcome = await run({ base: {}, head: { "src/new.ts": THREE } });

      expect(seedKeys(outcome.result)).toEqual([
        "src/new.ts :: :: function :: alpha added",
        "src/new.ts :: :: function :: beta added",
        "src/new.ts :: :: function :: gamma added",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds every callable in a deleted file",
    async () => {
      const outcome = await run({ base: { "src/old.ts": THREE }, head: {} });

      expect(seedKeys(outcome.result)).toEqual([
        "src/old.ts :: :: function :: alpha deleted",
        "src/old.ts :: :: function :: beta deleted",
        "src/old.ts :: :: function :: gamma deleted",
      ]);
      // A deleted callable exists only in base, which is where its callers are too.
      expect(
        outcome.result.seeds.every((seed) => seed.snapshot === "base"),
      ).toBe(true);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds both siblings when one hunk straddles them",
    async () => {
      const base =
        "export function alpha(): number {\n  return 1;\n}\nexport function beta(): number {\n  return 2;\n}\n";
      const head =
        "export function alpha(): number {\n  return 9;\n}\nexport function beta(): number {\n  return 8;\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: alpha modified",
        "src/a.ts :: :: function :: beta modified",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "attributes a nested change to the inner callable only",
    async () => {
      // Containment, not span: the inner one is the nearer attribution.
      const base =
        "export function outer(): number {\n  function inner(): number {\n    return 1;\n  }\n  return inner();\n}\n";
      const head =
        "export function outer(): number {\n  function inner(): number {\n    return 2;\n  }\n  return inner();\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: outer :: function :: inner modified",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("whitespace inside literals is part of the value", () => {
  it(
    "seeds a change to whitespace inside a template substitution",
    async () => {
      // A bare scanner has no parser context: after `${…}` it resumes in normal mode and
      // treats the literal's text as separator-delimited tokens, so the two strings
      // compare equal. They are different strings.
      const base =
        "export function f(x: string): string {\n  return `pre ${x}  post`;\n}\n";
      const head =
        "export function f(x: string): string {\n  return `pre ${x} post`;\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: f modified",
      ]);
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds a change to whitespace inside a regular expression",
    async () => {
      // `/` is a divide operator to a context-free scanner, so the regex body is read as
      // ordinary tokens and its spaces vanish. These match different inputs.
      const base =
        "export function f(s: string): boolean {\n  return /a  b/.test(s);\n}\n";
      const head =
        "export function f(s: string): boolean {\n  return /a b/.test(s);\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: f modified",
      ]);
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "still ignores a pure reflow, including the comma a formatter adds",
    async () => {
      const base =
        "export function f(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n";
      const head =
        "export function f(values: number[]): number {\n  return values.reduce(\n    (sum, value) => sum + value,\n    0,\n  );\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(outcome.result.seeds).toEqual([]);
      expect(outcome.result.accounting.formattingFiltered).toBeGreaterThan(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps an array hole distinct from a trailing comma",
    async () => {
      // `[a, ,]` has length 2 and `[a,]` has length 1. The trailing-comma exemption must
      // not collapse them.
      const base = "export function f(): unknown[] {\n  return [1, ,];\n}\n";
      const head = "export function f(): unknown[] {\n  return [1,];\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: f modified",
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("attribution past an ambiguous identity", () => {
  it(
    "seeds the enclosing callable and still reports the collision",
    async () => {
      // §8.2 as amended: a callable whose key collides is skipped for seeding,
      // attribution continues outward, and the gap is reported as well — both, not
      // either. JavaScript, because TypeScript rejects the redeclaration.
      const base = [
        "export function outer() {",
        "  function dup() {",
        "    return 1;",
        "  }",
        "  function dup() {",
        "    return 2;",
        "  }",
        "  return dup();",
        "}",
        "",
      ].join("\n");
      const head = base.replace("return 1;", "return 11;");
      const outcome = await run({
        base: { "src/a.js": base },
        head: { "src/a.js": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.js :: :: function :: outer modified",
      ]);
      const ambiguous = outcome.result.gaps.filter(
        (gap) => gap.kind === "ambiguous-identity",
      );
      expect(ambiguous).toHaveLength(1);
      expect(ambiguous[0]).toMatchObject({
        key: "src/a.js :: outer :: function :: dup",
      });
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "counts a hunk that yields both a seed and a gap once, as seed-consumed",
    async () => {
      // One file, one hunk, producing a seed and a gap together. Counting the gap as a
      // second hunk would let the accounting balance while a hunk went missing.
      const base = [
        "export function outer() {",
        "  function dup() {",
        "    return 1;",
        "  }",
        "  function dup() {",
        "    return 2;",
        "  }",
        "  return dup();",
        "}",
        "",
      ].join("\n");
      const head = base.replace("return 1;", "return 11;");
      const outcome = await run({
        base: { "src/a.js": base },
        head: { "src/a.js": head },
      });

      expect(outcome.result.seeds.length).toBeGreaterThan(0);
      expect(outcome.result.gaps.length).toBeGreaterThan(0);
      expect(outcome.result.accounting.seedConsumed).toBe(outcome.hunksInDiff);
      expect(outcome.result.accounting.gapOnly).toBe(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("hunks with nothing to attribute to", () => {
  it(
    "reports a gap for a file containing no callables at all",
    async () => {
      const outcome = await run({
        base: { "src/a.ts": "export const VALUE = 1;\n" },
        head: { "src/a.ts": "export const VALUE = 2;\n" },
      });

      expect(outcome.result.seeds).toEqual([]);
      expect(outcome.result.gaps.map((gap) => gap.kind)).toEqual([
        "unmapped-change",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "reports a pure deletion at the base line, where the removed code was",
    async () => {
      const base =
        "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n";
      const head = "export const A = 1;\nexport const C = 3;\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      const [gap] = outcome.result.gaps;
      expect(gap).toMatchObject({
        kind: "unmapped-change",
        snapshot: "base",
        line: 2,
      });
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});
