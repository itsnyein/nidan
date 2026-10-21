import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { SeedResult } from "../../src/analysis/seeds.js";

/**
 * A gap as a fixture records it.
 *
 * Deliberately coarser than a `SeedGap`: `expected.json` records `kind`, `snapshot`, the
 * file, and `reasonCode` — not lines or keys. Asserting more than the records carry would
 * fail every fixture whose record is simply less specific, which is a property of the
 * record format rather than a defect. T5.2 owns full expectation matching.
 */
interface RecordedGap {
  readonly kind: string;
  readonly snapshot: string;
  readonly file: string;
  readonly reasonCode: string;
}

/**
 * Asserts the gaps a fixture produced are exactly the gaps it records.
 *
 * Fixture gap expectations went unasserted through all of M2, and that was not a
 * theoretical gap. During T2.5 a manual sweep found `identity-collision` producing two
 * spurious `unmapped-change` gaps against a recorded expectation of **none**, while 242
 * tests passed: the code was wrong, the fixture was right, and nothing in the suite could
 * tell the difference. It would have surfaced at T5.2 as a regression with no obvious
 * cause.
 *
 * The comparison is by **set equality**, not containment. A missing gap means omen stopped
 * reporting something it must report; a spurious one means it reports something the
 * approved expectation says it must not. Both are defects, so neither direction may be
 * relaxed — subset matching (allowed elsewhere until T5.2, `decisions.md` §10) would hide
 * exactly the spurious-gap case the sweep found.
 */
export function expectGapsMatchFixture(result: SeedResult, name: string): void {
  const expected = recordedGaps(name);
  const actual = result.gaps
    .map((gap) => ({
      kind: gap.kind,
      snapshot: gap.snapshot,
      file: gap.filePath,
      reasonCode: gap.reasonCode,
    }))
    .map(render)
    .sort();

  expect(actual).toEqual(expected.map(render).sort());
}

/** The gaps a fixture's `expected.json` records. */
function recordedGaps(name: string): RecordedGap[] {
  const raw = readFileSync(
    join("tests", "fixtures", name, "expected.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as {
    expect: {
      repoWideGaps?: Array<{
        kind: string;
        snapshot?: string;
        site?: { file?: string };
        reasonCode: string;
      }>;
    };
  };
  return (parsed.expect.repoWideGaps ?? []).map((gap) => ({
    kind: gap.kind,
    snapshot: gap.snapshot ?? "head",
    file: gap.site?.file ?? "",
    reasonCode: gap.reasonCode,
  }));
}

/** One comparable line per gap, so a mismatch reads as a diff rather than object soup. */
function render(gap: RecordedGap): string {
  return `${gap.kind} ${gap.snapshot} ${gap.file} ${gap.reasonCode}`;
}
