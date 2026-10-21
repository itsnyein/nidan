import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds, type SeedResult } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";
import { expectEveryChangedLineAccounted } from "../../helpers/line-coverage.js";

const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Outcome {
  readonly result: SeedResult;
  /** Hunk count taken from the diff, independent of the mapper's own counter. */
  readonly hunksInDiff: number;
}

/** Runs the whole M2 chain over a fixture: diff, enumerate, map. */
async function seedOutcome(name: string): Promise<Outcome> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
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

  // Asserted here rather than in each test, so **every** fixture the suite exercises is
  // held to the line-level invariant — including ones added later, whose authors need not
  // remember to ask for it.
  expectEveryChangedLineAccounted(result, diff, head);

  return {
    result,
    hunksInDiff: diff.files.reduce(
      (total, file) => total + file.hunks.length,
      0,
    ),
  };
}

async function seedCase(name: string): Promise<SeedResult> {
  return (await seedOutcome(name)).result;
}

/** The seeds an approved fixture freezes, as `key → change`. */
function expectedSeeds(name: string): Array<[string, string]> {
  const raw = readFileSync(
    join("tests", "fixtures", name, "expected.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as {
    expect: { seeds?: Array<{ key: string; change: string }> };
  };
  return (parsed.expect.seeds ?? [])
    .map((seed): [string, string] => [seed.key, seed.change])
    .sort();
}

function actualSeeds(result: SeedResult): Array<[string, string]> {
  return result.seeds
    .map((seed): [string, string] => [seed.key, seed.change])
    .sort();
}

describe("classification against the frozen fixtures", () => {
  it.each([
    "seed-comment-change",
    "seed-added-deleted",
    "seed-declaration-form-change",
    "identity-overload",
    "identity-re-export",
    "overlay-basic",
    // The positive half of the boundary rule (§8.2 as amended): both lines adjacent to
    // the zero-count range lie inside the same callable, so the insertion seeds it.
    // These already hold on current main; the two between-function cases do not, and
    // wait for T2.4 below.
    "seed-boundary-insert-body-first",
    "seed-boundary-insert-body-last",
  ])(
    "%s seeds exactly what the fixture expects",
    async (name) => {
      const result = await seedCase(name);

      expect(actualSeeds(result)).toEqual(expectedSeeds(name));
    },
    TIMEOUT_MS,
  );

  it(
    "produces no seed for a reformatting-only change",
    async () => {
      const result = await seedCase("seed-whitespace-only");

      expect(result.seeds).toEqual([]);
      // And no gap either: the fixture freezes an empty report. A whitespace change is
      // accounted for by being recognised, not by being reported.
      expect(result.gaps).toEqual([]);
      expect(result.accounting.formattingFiltered).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds a comment change, which the formatting filter must not swallow",
    async () => {
      const result = await seedCase("seed-comment-change");

      expect(actualSeeds(result)).toEqual([
        ["src/calc.ts :: :: function :: total", "modified"],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "classifies added and deleted from the right snapshots, leaving the untouched alone",
    async () => {
      const result = await seedCase("seed-added-deleted");

      const byKey = new Map(result.seeds.map((seed) => [seed.key, seed]));
      expect(byKey.get("src/api.ts :: :: function :: added")?.change).toBe(
        "added",
      );
      expect(byKey.get("src/api.ts :: :: function :: added")?.snapshot).toBe(
        "head",
      );
      expect(byKey.get("src/api.ts :: :: function :: removed")?.change).toBe(
        "deleted",
      );
      // A deleted callable only exists in base, which is also where its callers are.
      expect(byKey.get("src/api.ts :: :: function :: removed")?.snapshot).toBe(
        "base",
      );
      // `kept` is untouched: present in a changed file, but not seeded.
      expect(byKey.has("src/api.ts :: :: function :: kept")).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "treats a declaration-form change as one modification, not a delete plus an add",
    async () => {
      const result = await seedCase("seed-declaration-form-change");

      expect(actualSeeds(result)).toEqual([
        ["src/format.ts :: :: function :: formatRow", "modified"],
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("a hunk that changes a callable and text outside it", () => {
  // §8.2 as amended 2026-10-21: a mixed hunk produces the seed **and** an
  // `unmapped-change` gap for the lines no covered callable accounts for, and is counted
  // once, as seed-consumed.
  //
  // Before T2.5, on `6992262`, this fixture yielded the `total` seed with `gaps: []` —
  // the `LIMIT` change got neither a seed nor a gap, because `mapSeeds` tested its
  // seed-consumed branch first and counted the whole hunk as consumed. That was the third
  // M2 silent miss of the same shape, one layer out from the two T2.4 closed.
  it(
    "seeds the callable and gaps the uncovered line",
    async () => {
      const outcome = await seedOutcome("seed-mixed-hunk");

      expect(actualSeeds(outcome.result)).toEqual(
        expectedSeeds("seed-mixed-hunk"),
      );
      // One gap. `LIMIT` is uncovered on both sides, but the base line is the replaced
      // counterpart of the uncovered head line, so the head gap already names the edit
      // (§8.2 as ruled 2026-10-21). A base gap would name the same edit twice.
      const unmapped = outcome.result.gaps.filter(
        (gap) => gap.kind === "unmapped-change",
      );
      expect(unmapped).toHaveLength(1);
      expect(unmapped[0]).toMatchObject({
        filePath: "src/calc.ts",
        reasonCode: "no-enclosing-callable",
        snapshot: "head",
        line: 1,
      });
      // Counted once: the gap is extra information about the hunk, not a second hunk.
      expect(outcome.result.accounting).toMatchObject({
        totalHunks: 1,
        seedConsumed: 1,
        formattingFiltered: 0,
        gapOnly: 0,
      });
    },
    TIMEOUT_MS,
  );
});

describe("boundary insertions and deletions", () => {
  // §8.2 as amended 2026-10-21: a zero-count range is a position *between* two lines. It
  // belongs to a callable only when both adjacent lines lie inside that same callable;
  // otherwise the hunk is an `unmapped-change` gap, never attributed to an unchanged
  // neighbour.
  //
  // Before T2.4 both cases produced `seeds: [], gaps: [], formattingFiltered: 1` on
  // `1452f50`: the insertion was attributed to an unchanged neighbour, compared equal,
  // and was absorbed by the formatting bucket — vanishing from the report while the
  // accounting balanced.
  // The snapshot and line are asserted here rather than in `expected.json`, which records
  // `site.file` only. For the deletion they are the interesting half of the expectation:
  // the removed text exists solely in base, so a gap reported against head would name a
  // line that does not contain the change.
  it.each([
    ["seed-boundary-insert-between", "head" as const, 5],
    ["seed-boundary-delete-between", "base" as const, 5],
  ])(
    "%s reports an unmapped-change gap in %s at line %i, seeding neither neighbour",
    async (name, snapshot, line) => {
      const outcome = await seedOutcome(name);

      expect(actualSeeds(outcome.result)).toEqual(expectedSeeds(name));
      const unmapped = outcome.result.gaps.filter(
        (gap) => gap.kind === "unmapped-change",
      );
      expect(unmapped).toHaveLength(1);
      expect(unmapped[0]).toMatchObject({
        filePath: "src/calc.ts",
        reasonCode: "no-enclosing-callable",
        snapshot,
        line,
      });
      // The guard that makes the miss impossible to hide: a hunk may only be counted as
      // formatting-filtered when its own changed text is formatting-only.
      expect(outcome.result.accounting.formattingFiltered).toBe(0);
      expect(outcome.result.accounting.gapOnly).toBe(1);
    },
    TIMEOUT_MS,
  );
});

describe("gaps", () => {
  it(
    "reports a hunk that maps to no callable",
    async () => {
      const result = await seedCase("seed-unmapped-change");

      expect(result.seeds).toEqual([]);
      const unmapped = result.gaps.filter(
        (gap) => gap.kind === "unmapped-change",
      );
      expect(unmapped.length).toBeGreaterThan(0);
      expect(unmapped[0]).toMatchObject({
        filePath: "src/types.ts",
        reasonCode: "no-enclosing-callable",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reports a collision and seeds neither colliding declaration",
    async () => {
      const result = await seedCase("identity-collision");

      const ambiguous = result.gaps.filter(
        (gap) => gap.kind === "ambiguous-identity",
      );
      expect(ambiguous).toHaveLength(1);
      expect(ambiguous[0]).toMatchObject({
        key: "src/dup.js :: :: function :: handle",
        reasonCode: "duplicate-structural-key",
      });
      expect(result.seeds.map((seed) => seed.key)).not.toContain(
        "src/dup.js :: :: function :: handle",
      );
    },
    TIMEOUT_MS,
  );
});

describe("attribution", () => {
  it(
    "seeds the changed function and not the untouched file that calls it",
    async () => {
      // overlay-basic changes the body of top-level `formatRow`; another file calls it
      // from inside `rows.map(...)` but does not itself change. That makes this a test
      // of cross-file restraint, not of callback attribution — the caller is unchanged,
      // so no arrow is involved in any hunk. Attribution into an anonymous callback is
      // tested directly in seeds-attribution.test.ts, on a hunk inside the arrow.
      const result = await seedCase("overlay-basic");

      expect(actualSeeds(result)).toEqual([
        ["src/format.ts :: :: function :: formatRow", "modified"],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "seeds only the innermost callable when callables nest",
    async () => {
      const result = await seedCase("identity-nested");

      // `alpha` encloses the changed `helper`. Seeding both would report the outer
      // function as changed when only its inner dependency was.
      expect(actualSeeds(result)).toEqual([
        ["src/outer.ts :: alpha :: function :: helper", "modified"],
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("hunk accounting", () => {
  // The testable half of the core guarantee at the diff stage: every hunk in a source
  // file becomes a seed, a documented filter, or a gap. Asserted as an equality rather
  // than inferred from an absence of failures.
  it.each([
    "overlay-basic",
    "seed-comment-change",
    "seed-whitespace-only",
    "seed-added-deleted",
    "seed-unmapped-change",
    "seed-declaration-form-change",
    "identity-overload",
    "identity-nested",
    "identity-collision",
    "identity-default-exports",
    "identity-constructor",
    "identity-static-vs-instance",
    "identity-re-export",
  ])(
    "%s accounts for every hunk in the diff",
    async (name) => {
      const outcome = await seedOutcome(name);
      const { totalHunks, seedConsumed, formattingFiltered, gapOnly } =
        outcome.result.accounting;

      // Compared against the diff, not against the mapper's own counter. Both buckets
      // and `totalHunks` derive from the same array inside the mapper, so checking one
      // against the other can never fail — and would not notice a hunk the mapper never
      // attributed at all.
      expect(totalHunks).toBe(outcome.hunksInDiff);
      expect(seedConsumed + formattingFiltered + gapOnly).toBe(
        outcome.hunksInDiff,
      );
      expect(outcome.hunksInDiff).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

describe("determinism", () => {
  it(
    "sorts seeds by key and gaps by file then line",
    async () => {
      const result = await seedCase("seed-added-deleted");

      const keys = result.seeds.map((seed) => seed.key);
      expect(keys).toEqual([...keys].sort());
      // More than one seed, or the sort assertion holds vacuously.
      expect(keys.length).toBeGreaterThan(1);
    },
    TIMEOUT_MS,
  );

  it(
    "orders gaps by file then line",
    async () => {
      const result = await seedCase("seed-unmapped-change");
      const ordered = result.gaps.map((gap) => [
        gap.filePath,
        gap.kind === "unmapped-change" ? gap.line : (gap.lines[0] ?? 0),
      ]);

      expect(ordered).toEqual([...ordered].sort());
      expect(ordered.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
