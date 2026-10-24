import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds, type SeedResult } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import {
  expectGapsEqual,
  expectGapsMatchFixture,
  allFixtures,
  parseRecordedGaps,
  recordedGaps,
  parseRecord,
  type RecordedGap,
} from "../../helpers/fixture-gaps.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 180_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * Every fixture that records a gap is checked here, by name, derived from the fixture
 * directories themselves.
 *
 * The claim "every fixture's gaps are asserted" has to be testable, not merely asserted in
 * a handoff. Enumerating the directories means a fixture added later with a recorded gap
 * is covered the moment it exists — nobody has to remember to wire it up, and forgetting
 * cannot pass silently.
 *
 * Running the chain here rather than inspecting which other tests happen to load a fixture
 * is deliberate: Vitest runs files in separate workers, so a registry populated by another
 * file would be invisible, and a coverage check that reads other test files' contents
 * would break on any refactor that moved a name. Asserting them directly makes the
 * property true by construction.
 */
/**
 * Fixtures whose records state a ruling that is **not yet implemented**, with the task
 * that implements it.
 *
 * Each entry is asserted to **fail** below, not skipped. A plain skip-list would be a
 * structural defect by `decisions.md` §7a: it could hide a genuine regression, and it
 * would outlive the fix silently. Asserting the failure means the day T2.7 lands, the
 * `still fails` test fails and forces the entry out of this map.
 */
// `seed-declaration-keyword` is deliberately **not** listed. Its ruling concerns seeds,
// and it records no gaps, so the gap assertion matches trivially — listing it would assert
// a failure that does not occur, and the entry would later need removing for a reason
// unrelated to the fix. Its seed expectation is pending in `seeds.test.ts`.
const PENDING = new Map<string, string>([
  // Entries assert the **current wrong behaviour**, so an implemented ruling makes its
  // entry fail and forces removal — a skip-list that cannot outlive its fix.
  [
    "gap-interface-dispatch",
    "the dispatch gap is not implemented: the seed implements an interface member and no gap is emitted",
  ],
  [
    "gap-override-dispatch",
    "the dispatch gap is not implemented: the seed overrides a base method and no gap is emitted",
  ],
  [
    "gap-untyped-member-call",
    "untyped-member-call is not implemented: the any-receiver call emits no gap",
  ],
]);

describe("every fixture is asserted against its record", () => {
  const names = allFixtures().filter((name) => !PENDING.has(name));

  it("enumerates every fixture directory holding an expected.json", () => {
    // Guards the enumeration against *shrinking*, not merely against emptying. An earlier
    // version checked only `length > 0`, which catches zero fixtures but not "one fewer" —
    // and the enumeration keyed on record content, so a record emptying itself dropped
    // out of the list and took its own assertion with it.
    const directories = readdirSync(join("tests", "fixtures"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        existsSync(join("tests", "fixtures", name, "expected.json")),
      )
      .sort();

    expect([...names, ...PENDING.keys()].sort()).toEqual(directories);
    expect(names.length).toBeGreaterThan(0);
  });

  it("lists exactly the fixtures whose gap kinds are unimplemented", () => {
    // The map is not empty any more, and that has to stay deliberate. Naming the entries
    // means adding a fourth fails here until someone justifies it, which is what the
    // empty-map version bought and a bare length check would give away.
    expect([...PENDING.keys()].sort()).toEqual([
      "gap-interface-dispatch",
      "gap-override-dispatch",
      "gap-untyped-member-call",
    ]);
  });

  it.each([...PENDING])(
    "%s still records a gap it does not produce",
    async (name) => {
      // Asserted to fail, not skipped: each records a gap for a kind that does not exist
      // yet, so the day it lands this fails and forces the entry out.
      const result = await runFixture(name);
      expect(result.gaps).toEqual([]);
      expect(recordedGaps(name).length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it.each(names)(
    "%s produces exactly the gaps it records",
    async (name) => {
      expectGapsMatchFixture(await runFixture(name), name);
    },
    TIMEOUT_MS,
  );
});

/** Runs the whole chain over a fixture and asserts its gaps against its record. */
/** Runs a fixture and returns its seed result, asserting nothing. */
async function runFixture(name: string): Promise<SeedResult> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  const diff = await diffCommits(repo.path, repo.baseSha, repo.headSha);
  const result = mapSeeds({
    diff,
    base: enumerateCallables(pair.base.project.getSourceFiles(), repo.path),
    head: enumerateCallables(pair.head.project.getSourceFiles(), repo.path),
  });

  return result;
}

describe("the case table lists every fixture", () => {
  it("names each fixture directory exactly once", () => {
    // The table had drifted sixteen entries behind the directories before anyone noticed,
    // because nothing compared the two. Enumerating here makes the index self-correcting:
    // a fixture added without a row fails this, and a row naming a directory that no
    // longer exists fails it too.
    const table = readFileSync(join("tests", "fixtures", "README.md"), "utf8");
    const listed = [...table.matchAll(/^\| \[`([^`]+)`\]\(/gmu)].map(
      (match) => match[1],
    );

    expect([...listed].sort()).toEqual(allFixtures());
  });
});

describe("the gap comparison is a multiset", () => {
  const gap = (reasonCode = "no-enclosing-callable"): RecordedGap => ({
    kind: "unmapped-change",
    snapshot: "head",
    file: "src/a.ts",
    reasonCode,
  });

  it("fails when the code emits a duplicate the record does not have", () => {
    // The `identity-collision` defect emitted two *identical* gaps where the record had
    // none. A comparison that deduplicated — a `Set`, or `expect.arrayContaining` — would
    // have called one gap and two gaps the same thing. Synthetic inputs because no current
    // fixture records a duplicate, so this cannot be expressed through a fixture at all.
    expect(() => {
      expectGapsEqual([gap(), gap()], [gap()], "duplicate-emitted");
    }).toThrow();
  });

  it("fails when the record has a duplicate the code does not emit", () => {
    // The reverse direction. Testing only the first would pass an implementation that
    // checked "every emitted gap is recorded" and ignored multiplicity in the record.
    expect(() => {
      expectGapsEqual([gap()], [gap(), gap()], "duplicate-recorded");
    }).toThrow();
  });

  it("passes when both sides hold the same duplicate", () => {
    // Keeps the rule honest in the other direction: duplicates are compared, not banned.
    expect(() => {
      expectGapsEqual([gap(), gap()], [gap(), gap()], "duplicate-both");
    }).not.toThrow();
  });

  it.each([
    ["kind", { kind: "ambiguous-identity" }],
    ["snapshot", { snapshot: "base" }],
    ["file", { file: "src/other.ts" }],
    ["reasonCode", { reasonCode: "duplicate-structural-key" }],
  ])("fails when only %s differs and the count matches", (_field, override) => {
    // One case per compared field. Varying a single field left the other three
    // undefended: dropping `kind`, `snapshot`, or `file` from the rendered string each
    // passed the whole suite, so three of the four were compared by nothing.
    expect(() => {
      expectGapsEqual([{ ...gap(), ...override }], [gap()], "field");
    }).toThrow();
  });

  it("does not confuse field boundaries when a value contains a space", () => {
    // A space-joined rendering made these two compare equal.
    expect(() => {
      expectGapsEqual(
        [{ ...gap(), file: "src/a b.ts", reasonCode: "x" }],
        [{ ...gap(), file: "src/a", reasonCode: "b.ts x" }],
        "boundary",
      );
    }).toThrow();
  });
});

describe("recorded gaps must state every field", () => {
  const complete = {
    kind: "unmapped-change",
    snapshot: "head",
    site: { file: "src/a.ts" },
    reasonCode: "no-enclosing-callable",
  };

  it.each([
    ["kind", { ...complete, kind: undefined }],
    ["snapshot", { ...complete, snapshot: undefined }],
    ["site.file", { ...complete, site: undefined }],
    ["reasonCode", { ...complete, reasonCode: undefined }],
  ])("a record missing %s is a test error, not a default", (field, record) => {
    // A default would silently compare equal to whatever the code produced, making the
    // record less strict than it looks while appearing to assert something. Driven
    // through the same `parseRecordedGaps` the fixture reader uses, so this tests the
    // rule rather than a copy of it.
    expect(() => {
      parseRecordedGaps([record], "synthetic");
    }).toThrow(new RegExp(field.replace(".", "\\.")));
  });

  it("names the fixture and index in the error", () => {
    // The failure has to be actionable without opening the helper.
    expect(() => {
      parseRecordedGaps([{ ...complete, kind: undefined }], "some-fixture");
    }).toThrow(/some-fixture: repoWideGaps\[0\]/);
  });

  it.each([
    ["null", null],
    ["a number", 1],
    ["an object", {}],
  ])("a %s field is a test error, not a value", (_label, value) => {
    // `required` rejected only `undefined`, so a record carrying null or a number passed
    // validation and then merely *differed*, reporting a mismatch rather than a broken
    // record.
    expect(() => {
      // Cast through `unknown`: the point is a record whose field is *not* a string,
      // which the declared parameter type forbids by construction. A malformed JSON file
      // can carry exactly this, so the runtime check has to exist regardless.
      parseRecordedGaps(
        [{ ...complete, kind: value }] as unknown as Parameters<
          typeof parseRecordedGaps
        >[0],
        "synthetic",
      );
    }).toThrow(/kind/);
  });

  it.each([
    ["no expect object", {}, /has no "expect" object/],
    ["no repoWideGaps array", { expect: {} }, /repoWideGaps/],
  ])("rejects a record with %s", (_label, record, pattern) => {
    // Driven through `parseRecord` with a **synthetic parsed record**, so the rule
    // itself runs. The previous version passed a non-existent fixture name, so
    // `readFileSync` threw ENOENT before any of this was reached and a bare
    // `.toThrow()` accepted it — the named rule was defended by nothing, and removing
    // it left the suite green (§7a).
    expect(() => {
      parseRecord(record, "synthetic");
    }).toThrow(pattern);
  });

  it("accepts a record that explicitly states no gaps", () => {
    // The other direction: `[]` is a real assertion and must not be rejected alongside a
    // missing key.
    expect(parseRecord({ expect: { repoWideGaps: [] } }, "synthetic")).toEqual(
      [],
    );
  });

  it("accepts a complete record", () => {
    expect(parseRecordedGaps([complete], "synthetic")).toEqual([
      {
        kind: "unmapped-change",
        snapshot: "head",
        file: "src/a.ts",
        reasonCode: "no-enclosing-callable",
      },
    ]);
  });
});
