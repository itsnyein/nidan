import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds, type SeedResult } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";
import { expectEveryChangedLineAccounted } from "../../helpers/line-coverage.js";

// Each case builds a real Git repository and loads a TypeScript program, and the cases
// run in parallel with the rest of the suite. Individually they take a second or two, but
// under full load one has been observed at 63 s. The limit guards against a hang, not
// against slowness, so it is set well clear of the contended case.
const TIMEOUT_MS = 180_000;

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
  const head = enumerateCallables(
    pair.head.project.getSourceFiles(),
    repo.path,
  );
  const result = mapSeeds({
    diff,
    base: enumerateCallables(pair.base.project.getSourceFiles(), repo.path),
    head,
  });

  // Every throwaway case is held to the invariant too, not only the frozen fixtures.
  expectEveryChangedLineAccounted(result, diff, head);

  return {
    result,
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

describe("the boundary rule, isolated from the formatting guard", () => {
  it(
    "gaps an insertion next to a function that is itself seeded by another hunk",
    async () => {
      // The two rules overlap on the E2c fixtures: there the insertion's neighbour is
      // unchanged, so the formatting guard alone already turns the hunk into a gap and
      // the boundary rule is never the deciding factor. This case separates them.
      //
      // Why this input has the claimed shape: `SCALE` is inserted between the two
      // functions **and** `second`'s body changes, far enough apart that Git emits two
      // hunks — verified as `@@ -4,0 +5,2 @@` and `@@ -6 +8 @@` under the pinned flags.
      // The first is the zero-count insertion; the second makes `second` a seed.
      //
      // Under the old reading the insertion's position touched `second`, which is now
      // seeded, so the hunk counted as seed-consumed — and the formatting guard never
      // ran, because the seeded branch is tested first. The inserted statement vanished
      // into a seed it has nothing to do with. Only the boundary rule catches this.
      const base = [
        "export function first(): number {",
        "  return 1;",
        "}",
        "",
        "export function second(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n");
      const head = [
        "export function first(): number {",
        "  return 1;",
        "}",
        "",
        "const SCALE = 10;",
        "",
        "export function second(): number {",
        "  return 99;",
        "}",
        "",
      ].join("\n");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(outcome.hunksInDiff).toBe(2);
      // `second` really did change, so it is a seed.
      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: second modified",
      ]);
      // And the insertion is still reported rather than absorbed into that seed.
      const unmapped = outcome.result.gaps.filter(
        (gap) => gap.kind === "unmapped-change",
      );
      expect(unmapped).toHaveLength(1);
      expect(outcome.result.accounting).toMatchObject({
        seedConsumed: 1,
        formattingFiltered: 0,
        gapOnly: 1,
      });
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("a hunk with two separate uncovered regions", () => {
  it(
    "reports a gap for each region, not just the first",
    async () => {
      // Found by the T2.5 reviewer against unmutated code. One hunk leaves two separate
      // regions unaccounted for — a top-level line above the callable and another below
      // it. Emitting a single gap per hunk names only the first, so the `OTHER` change is
      // real, unreported, and the accounting still balances: this task's own failure mode
      // surviving at a finer grain than the hunk.
      //
      // Why this input has the claimed shape: all three lines are edited and adjacent, so
      // Git emits one hunk (`@@ -1,3 +1,3 @@`, asserted below). `total` is written on a
      // single line so that the covered line sits *between* the two uncovered ones —
      // split across lines it would merge the regions into one run and the case would
      // vanish.
      const base = [
        "export const LIMIT = 1;",
        "export function total(): number { return 1; }",
        "export const OTHER = 1;",
        "",
      ].join("\n");
      const head = [
        "export const LIMIT = 2;",
        "export function total(): number { return 9; }",
        "export const OTHER = 2;",
        "",
      ].join("\n");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(outcome.hunksInDiff).toBe(1);
      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: total modified",
      ]);

      const unmapped = outcome.result.gaps
        .filter((gap) => gap.kind === "unmapped-change")
        .map((gap) => `${gap.snapshot}:${String(gap.line)}`)
        .sort();
      // Both sides, per the 2026-10-21 ruling: the base side's uncovered lines are a
      // real deletion of text and are named on their own snapshot, not represented by
      // the head gap.
      expect(unmapped).toEqual(["base:1", "base:3", "head:1", "head:3"]);
      // Counted once, as seed-consumed: two gaps about one hunk are not two hunks.
      expect(outcome.result.accounting).toMatchObject({
        totalHunks: 1,
        seedConsumed: 1,
        gapOnly: 0,
      });
    },
    TIMEOUT_MS,
  );
});

describe("a boundary position must not seed a neighbour it is outside", () => {
  it(
    "does not seed an unchanged nested callable whose container was renamed",
    async () => {
      // The case that proves `boundaryOwners` is load-bearing. Found by the T2.5
      // reviewer after I wrongly reported the rule as unreachable: I only looked for
      // neighbours whose *text* changed, and the distinguishing case is a neighbour
      // whose **key** changes while its text does not.
      //
      // Why this input has the claimed shape: renaming `C` to `C2` re-keys `B` from
      // `C.m :: function :: B` to `C2.m :: function :: B`, so base `B` has no head
      // counterpart and would classify as `deleted` if anything attributed to it. The
      // inserted line sits between `const x` (innermost owner `m`) and `B`'s declaration
      // (innermost owner `B`), so the two adjacent lines have **different** innermost
      // owners — the condition the boundary rule turns on. Verified as three hunks under
      // the pinned flags, the middle one `@@ -5,0 +6 @@`, a true zero-count range.
      //
      // Taking the union of both neighbours instead attributes the insertion to `B` and
      // emits a spurious `B deleted`: an unchanged callable reported as deleted because
      // a line was inserted *outside* it.
      const base = [
        "export const TOP = 1;",
        "",
        "export class C {",
        "  m(): number {",
        "    const x = 1;",
        "    function B(): number { return 2; }",
        "    return x + B();",
        "  }",
        "}",
        "",
      ].join("\n");
      const head = [
        "export const TOP = 1;",
        "",
        "export class C2 {",
        "  m(): number {",
        "    const x = 1;",
        "    const INS = 0;",
        "    function B(): number { return 2; }",
        "    return x + B() + INS;",
        "  }",
        "}",
        "",
      ].join("\n");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(outcome.hunksInDiff).toBe(3);
      // `B` is untouched in both snapshots; only its container's name changed.
      expect(seedKeys(outcome.result)).not.toContain(
        "src/a.ts :: C.m :: function :: B deleted",
      );
      expect(seedKeys(outcome.result)).not.toContain(
        "src/a.ts :: C2.m :: function :: B added",
      );
    },
    TIMEOUT_MS,
  );
});

describe("the formatting bucket requires formatting-only text", () => {
  it(
    "gaps a hunk whose changed text lies outside every equal-comparing callable",
    async () => {
      // Rule 2 tested *independently of the boundary rule*: this hunk has real lines on
      // both sides, so it never reaches the zero-count branch.
      //
      // Why this input has the claimed shape: `LIMIT` is on the line **immediately
      // before** the reformatted signature, so both edits are contiguous and Git emits a
      // single hunk, verified as `@@ -1,2 +1,5 @@` under the pinned flags. Putting
      // `LIMIT` after the function body instead produces two hunks — the substantive one
      // is then already a gap on its own and the test proves nothing. That is the first
      // way I wrote it.
      //
      // `keep` is reformatted only (argument list rewrapped, trailing comma added) so it
      // compares equal, which under the old rule was enough to put the whole hunk in the
      // formatting bucket — taking the substantive `LIMIT` edit with it.
      const base = [
        "const LIMIT = 1;",
        "export function keep(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
      ].join("\n");
      const head = [
        "const LIMIT = 2;",
        "export function keep(",
        "  a: number,",
        "  b: number,",
        "): number {",
        "  return a + b;",
        "}",
        "",
      ].join("\n");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      // One hunk: if Git split these into two, the substantive edit would be a gap on
      // its own and the guard would not be under test.
      expect(outcome.hunksInDiff).toBe(1);
      // `keep` is reformatting only, so it is not a seed.
      expect(seedKeys(outcome.result)).toEqual([]);
      // But the `LIMIT` change is real and belongs to no callable, so the hunk cannot be
      // filtered: it is reported.
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
      const unmapped = outcome.result.gaps.filter(
        (gap) => gap.kind === "unmapped-change",
      );
      expect(unmapped.length).toBeGreaterThan(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "still filters a hunk whose changed text is entirely inside an equal callable",
    async () => {
      // The other side of the guard: the same reformatting with no substantive edge.
      // Without this, a guard that rejected everything would pass the test above.
      const base =
        "export function keep(a: number, b: number): number {\n  return a + b;\n}\n";
      const head = [
        "export function keep(",
        "  a: number,",
        "  b: number,",
        "): number {",
        "  return a + b;",
        "}",
        "",
      ].join("\n");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([]);
      expect(outcome.result.gaps).toEqual([]);
      expect(outcome.result.accounting.formattingFiltered).toBeGreaterThan(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("insertions at a file boundary", () => {
  it(
    "gaps a line inserted before the first line of a file",
    async () => {
      // A zero-count range at line 0: there is no line *before* the insertion point, so
      // no callable can contain both sides. The rule's "both adjacent lines" cannot be
      // satisfied, and the alternative — treating the single existing neighbour as the
      // owner — is what attributed insertions to unchanged code in the first place.
      const base = "export function only(): number {\n  return 1;\n}\n";
      const head = "const HEADER = 1;\n" + base;
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([]);
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
      expect(outcome.result.accounting.gapOnly).toBe(1);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds a line appended after the last line of a function at the end of a file",
    async () => {
      // The mirror case, and the one an off-by-one at the end of the file would break:
      // the insertion point is between the final statement and the closing brace, both
      // inside `only`.
      const base =
        "export function only(values: number[]): void {\n  values.push(1);\n}\n";
      const head =
        "export function only(values: number[]): void {\n  values.push(1);\n  values.push(2);\n}\n";
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: only modified",
      ]);
      expect(outcome.result.gaps).toEqual([]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

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

describe("a hunk covering a mixture of owners", () => {
  it(
    "seeds the outer callable too when one hunk changes both it and a nested one",
    async () => {
      // The two edits are on *adjacent* lines, so with `--unified=0` Git emits a single
      // hunk spanning both. Line 2 belongs to `outer`, line 3 to `inner`. Attributing
      // the hunk as a whole to its innermost member drops the `outer` change entirely —
      // no seed, no gap — while the accounting still balances, which is exactly the
      // failure hunk accounting exists to catch.
      const base = [
        "export function outer(): number {",
        "  const n = 1;",
        "  function inner(): number { return 1; }",
        "  return n + inner();",
        "}",
        "",
      ].join("\n");
      const head = base
        .replace("const n = 1;", "const n = 2;")
        .replace("{ return 1; }", "{ return 3; }");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      // One hunk, two owners. Both must be seeded.
      expect(outcome.hunksInDiff).toBe(1);
      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: outer modified",
        "src/a.ts :: outer :: function :: inner modified",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it.each([
    [
      "two declarators in one statement",
      "export const a = () => 1, b = () => 2;\n",
      "export const a = () => 1, b = () => 3;\n",
    ],
    [
      "two one-line function declarations",
      "export function a(): number { return 1; } export function b(): number { return 2; }\n",
      "export function a(): number { return 1; } export function b(): number { return 3; }\n",
    ],
  ])(
    "seeds the changed one of two siblings sharing a line: %s",
    async (_label, base, head) => {
      // Both siblings are on **one line**, which is what makes this a test: split across
      // two lines each owns its own line and any single-owner rule finds it. Siblings are
      // not inside one another, so reducing a shared line to a single owner picks one
      // arbitrarily — by key order — and discards the other with no seed and no gap while
      // the accounting still balances. Changing `b`, the later key, is the failing case;
      // changing `a` would pass either way.
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: b modified",
      ]);
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds only the inner callable when an outer and inner share one line",
    async () => {
      // Identical line spans. A line-based containment test calls these siblings and
      // seeds both; §8.2 wants the innermost only. Character positions separate them.
      const base =
        "export function outer(): number { function inner(): number { return 1; } return inner(); }\n";
      const head = base.replace("return 1;", "return 2;");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: outer :: function :: inner modified",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds a newly added outer function and its nested one",
    async () => {
      const head = [
        "export function outer(): number {",
        "  function inner(): number {",
        "    return 1;",
        "  }",
        "  return inner();",
        "}",
        "",
      ].join("\n");
      const outcome = await run({ base: {}, head: { "src/a.ts": head } });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: outer added",
        "src/a.ts :: outer :: function :: inner added",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );

  it(
    "attributes a change inside an anonymous callback to the enclosing callable",
    async () => {
      // The change is *inside* the arrow, which is unsupported, so the nearest supported
      // callable owns it. A fixture whose change sits in a different function entirely
      // says nothing about this rule.
      const base = [
        "export function render(rows: string[]): string[] {",
        "  return rows.map((row) => row.trim());",
        "}",
        "",
      ].join("\n");
      const head = base.replace("row.trim()", "row.trimEnd()");
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: render modified",
      ]);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("comments anywhere in a declaration count", () => {
  // §8.1 is explicit that a comment edit is a modification: a comment can state a
  // contract callers rely on. Collecting only *leading* comment ranges misses a comment
  // that follows code on the same line — it is not the leading trivia of any later
  // token — so the signatures match and the hunk is filtered away as formatting.
  it.each([
    [
      "a same-line line comment",
      "export function f(): number {\n  return 1; // old contract\n}\n",
      "export function f(): number {\n  return 1; // new contract\n}\n",
    ],
    [
      "a same-line block comment",
      "export function f(): number {\n  return 1; /* old contract */\n}\n",
      "export function f(): number {\n  return 1; /* new contract */\n}\n",
    ],
    [
      "a trailing comment before the closing brace",
      "export function f(): number {\n  return 1;\n  // old note\n}\n",
      "export function f(): number {\n  return 1;\n  // new note\n}\n",
    ],
    [
      "a leading JSDoc",
      "/** old */\nexport function f(): number {\n  return 1;\n}\n",
      "/** new */\nexport function f(): number {\n  return 1;\n}\n",
    ],
  ])(
    "seeds a change to %s",
    async (_label, base, head) => {
      const outcome = await run({
        base: { "src/a.ts": base },
        head: { "src/a.ts": head },
      });

      expect(seedKeys(outcome.result)).toEqual([
        "src/a.ts :: :: function :: f modified",
      ]);
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
      expectAccountsForEveryHunk(outcome);
    },
    TIMEOUT_MS,
  );
});

describe("the formatting filter's exemption list is closed", () => {
  // Whitespace and a trailing comma before a closing bracket, and nothing else. Each case
  // below is something a formatter may rewrite, and each must still be a modification:
  // every one of these tokens can change meaning somewhere, and a filter that grows by
  // analogy stops being a filter.
  it.each([
    [
      "a semicolon",
      "export function f(): number {\n  return 1;\n}\n",
      "export function f(): number {\n  return 1\n}\n",
    ],
    [
      "quote style",
      "export function f(): string {\n  return 'a';\n}\n",
      'export function f(): string {\n  return "a";\n}\n',
    ],
    [
      "redundant parentheses",
      "export function f(x: number): number {\n  return (x) + 1;\n}\n",
      "export function f(x: number): number {\n  return x + 1;\n}\n",
    ],
  ])(
    "seeds a change to %s",
    async (_label, base, head) => {
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
      // One per side: the modified line is uncovered in both snapshots, and each side's
      // uncovered run is named on its own snapshot (§8.2 as ruled 2026-10-21).
      expect(outcome.result.gaps.map((gap) => gap.kind)).toEqual([
        "unmapped-change",
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
