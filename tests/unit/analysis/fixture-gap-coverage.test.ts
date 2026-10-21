import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import {
  expectGapsEqual,
  expectGapsMatchFixture,
  fixturesWithRecordedGaps,
  parseRecordedGaps,
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
describe("every fixture with recorded gaps is asserted", () => {
  const names = fixturesWithRecordedGaps();

  it("finds the fixtures that record gaps", () => {
    // Guards the enumeration itself. If a path change made this return nothing, the
    // `it.each` below would silently run zero cases and the suite would stay green while
    // asserting nothing at all.
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)(
    "%s produces exactly the gaps it records",
    async (name) => {
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

      expectGapsMatchFixture(result, name);
    },
    TIMEOUT_MS,
  );
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

  it("fails when a field differs but the count matches", () => {
    // A length-only comparison would pass this.
    expect(() => {
      expectGapsEqual([gap("duplicate-structural-key")], [gap()], "field");
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
