import { expect } from "vitest";

import type { DiffResult } from "../../src/analysis/diff.js";
import type { CallableIndex } from "../../src/analysis/identity.js";
import type { SeedResult } from "../../src/analysis/seeds.js";

/**
 * Asserts the line-level accounting invariant of §8.2 (as amended 2026-10-21):
 *
 * > Every changed line — on both sides, including the positions zero-count ranges denote
 * > — is covered exactly once by a seeded callable's range, a formatting-equal callable,
 * > or a reported gap.
 *
 * This exists because hunk-level counting cannot express the guarantee it was built to
 * prove. A hunk is a bucket of lines, so it can be counted as accounted-for while lines
 * inside it are dropped — which is what every M2 silent miss did, one layer apart each
 * time: siblings sharing a line, a boundary insertion's own text, and substantive text
 * beside a seeded callable. Asserting per line makes the next instance of that shape fail
 * a test rather than wait to be discovered.
 *
 * Takes the diff as well as the result so the expected line set is computed
 * **independently** of the mapper. Comparing the mapper's coverage against the mapper's
 * own notion of which lines changed would be tautological, which is the defect an earlier
 * review found in the hunk-count assertion this replaces.
 */
export function expectEveryChangedLineAccounted(
  result: SeedResult,
  diff: DiffResult,
  head?: CallableIndex,
): void {
  const expected = changedLinesFromDiff(diff);
  const actual = result.coverage.map(
    (line) => `${line.snapshot}:${line.filePath}:${String(line.line)}`,
  );

  // Exactly once: no changed line missing, and none classified twice.
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(new Set(actual).size).toBe(actual.length);

  // Every uncovered line must be answered by a gap in the same file. Coverage alone
  // would otherwise be satisfied by classifying a line and then reporting nothing.
  const gapFiles = new Set(result.gaps.map((gap) => gap.filePath));
  for (const line of result.coverage) {
    if (line.bucket !== "uncovered") continue;
    expect(gapFiles.has(line.filePath)).toBe(true);
  }

  // Owner completeness: every callable whose range contains a changed head line must
  // have been *examined* — seeded, or compared and found equal. This is the half that
  // catches a dropped owner, which the coverage check alone cannot: when attribution
  // keeps only one of two callables sharing a line, the line is still covered by the one
  // it kept, and the other's change disappears with the invariant satisfied. That is
  // exactly the sibling miss T2.3's review found.
  //
  // Needs the callable index, because "a callable that was never examined" is invisible
  // in the result by construction — the absence of a key is indistinguishable from a key
  // that was legitimately unchanged unless the full set of candidates is known.
  if (head !== undefined) {
    const examined = new Set([
      ...result.seeds.map((seed) => seed.key),
      ...result.formattingEqualKeys,
    ]);
    const changedHeadLines = new Set(
      result.coverage
        .filter((line) => line.snapshot === "head")
        .map((line) => `${line.filePath}:${String(line.line)}`),
    );
    for (const key of innermostOwnersOfChangedLines(head, changedHeadLines)) {
      expect(
        examined.has(key),
        `${key} is the innermost callable over a changed line but was never seeded or compared`,
      ).toBe(true);
    }
  }

  // A line labelled `seeded` must actually lie inside a reported seed's range. Without
  // this the assertion would only check that `mapSeeds` labelled every line — and a
  // bucket decided for the hunk as a whole would label an outside line `seeded` and pass,
  // which is the precise shape of the mixed-hunk miss. Checking the label against the
  // reported seed ranges is what makes this an invariant rather than a restatement of
  // the implementation.
  //
  // Head side only: a `modified` seed reports its **head** range, so a base-side line of
  // the same callable has no reported range to check against. Added and deleted seeds are
  // covered on their own snapshot. This is a real limit on the invariant's strength, not
  // an oversight.
  const seedRanges = result.seeds.filter((seed) => seed.snapshot === "head");
  for (const line of result.coverage) {
    if (line.bucket !== "seeded" || line.snapshot !== "head") continue;
    const inside = seedRanges.some(
      (seed) =>
        seed.filePath === line.filePath &&
        line.line >= seed.startLine &&
        line.line <= seed.endLine,
    );
    expect(
      inside,
      `head line ${String(line.line)} of ${line.filePath} is labelled "seeded" but lies outside every reported seed range`,
    ).toBe(true);
  }
}

/**
 * The changed lines a diff holds, derived from the hunk ranges alone.
 *
 * A zero-count range contributes no line: it is a position between two lines, and the
 * text it denotes lives on the opposite side of the hunk, which is counted there. A
 * deleted file has no head side and an added file no base side (§5.1).
 */
function changedLinesFromDiff(diff: DiffResult): string[] {
  const lines: string[] = [];
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      if (file.change !== "added") {
        for (let i = 0; i < hunk.base.count; i += 1) {
          lines.push(`base:${file.path}:${String(hunk.base.start + i)}`);
        }
      }
      if (file.change !== "deleted") {
        for (let i = 0; i < hunk.head.count; i += 1) {
          lines.push(`head:${file.path}:${String(hunk.head.start + i)}`);
        }
      }
    }
  }
  return lines;
}

/**
 * The innermost callables over each changed line, derived from the index.
 *
 * Per §8.2 as amended, a line belongs to the **innermost** callable with a unique
 * identity; an enclosing callable does not also cover it. So only the innermost ones are
 * required to have been examined — demanding it of every containing callable would
 * contradict the attribution rule and fail on correct nested output.
 *
 * Derived here independently of `mapSeeds` on purpose. Reading the owner set back out of
 * the result would make this a restatement of the implementation rather than a check on
 * it, which is the failure this whole invariant exists to end. The cost is that the two
 * derivations can drift — and that drift is itself the signal worth having.
 */
function innermostOwnersOfChangedLines(
  index: CallableIndex,
  changedLines: ReadonlySet<string>,
): string[] {
  const owners = new Set<string>();
  for (const entry of changedLines) {
    const separator = entry.lastIndexOf(":");
    const filePath = entry.slice(0, separator);
    const line = Number(entry.slice(separator + 1));

    const containing = index.callables.filter(
      (callable) =>
        callable.filePath === filePath &&
        line >= callable.startLine &&
        line <= callable.endLine,
    );
    for (const candidate of containing) {
      const hasInnerCandidate = containing.some(
        (other) =>
          other !== candidate &&
          other.startPos >= candidate.startPos &&
          other.endPos <= candidate.endPos,
      );
      if (!hasInnerCandidate) owners.add(candidate.key);
    }
  }
  return [...owners];
}
