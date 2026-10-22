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
  base?: CallableIndex,
): void {
  const expected = changedLinesFromDiff(diff);
  const actual = result.coverage.map(
    (line) => `${line.snapshot}:${line.filePath}:${String(line.line)}`,
  );

  // Exactly once: no changed line missing, and none classified twice.
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(new Set(actual).size).toBe(actual.length);

  // Every uncovered line must be answered by a gap that actually names its **region**,
  // not merely by some gap somewhere in the same file. A file-level check passes when a
  // hunk leaves two separate regions uncovered and only one is reported — the second
  // change is then unreported with the invariant satisfied, which is this task's own
  // failure mode surviving at a finer grain.
  //
  // A gap names the first line of a contiguous run, so an uncovered line is answered when
  // a gap on its snapshot sits at or before it with every line between them also
  // uncovered. Reported on one snapshot per hunk, so a line whose own side was not the
  // reported one is answered by the gap on the other side of the same change.
  const uncovered = result.coverage.filter(
    (line) => line.bucket === "uncovered",
  );
  const uncoveredKeys = new Set(
    uncovered.map(
      (line) => `${line.snapshot}:${line.filePath}:${String(line.line)}`,
    ),
  );
  const gapsByFile = new Map<string, number[]>();
  for (const gap of result.gaps) {
    if (gap.kind !== "unmapped-change") continue;
    const key = `${gap.snapshot}:${gap.filePath}`;
    gapsByFile.set(key, [...(gapsByFile.get(key) ?? []), gap.line]);
  }

  for (const line of uncovered) {
    // A gap names the first line of a contiguous run, so a line is answered when a gap
    // on **its own snapshot** sits at or before it with every line between also
    // uncovered. No cross-snapshot fallback: every uncovered run is reported on its own
    // side (§8.2 as ruled 2026-10-21), and accepting a gap from the other side was how
    // round 1's condemned file-level check crept back in as a disjunct.
    // A base line may be answered by the **head** gap for the same edit: the base line at
    // offset n was replaced by the head line at offset n, so when that counterpart is
    // itself uncovered the head gap names the edit and a base gap would duplicate it
    // (§8.2 as ruled 2026-10-21).
    //
    // This is deliberately narrow. An earlier version accepted *any* gap elsewhere in the
    // file, which is the file-level check round 1 condemned — it excused lines nothing
    // named. Here the specific counterpart line must itself be uncovered, so a base line
    // with no counterpart (deleted text) is never excused.
    if (
      line.snapshot === "base" &&
      hasUncoveredCounterpart(line, diff, uncoveredKeys)
    ) {
      continue;
    }

    const sameSide = gapsByFile.get(`${line.snapshot}:${line.filePath}`) ?? [];
    const answered = sameSide.some((start) => {
      if (start > line.line) return false;
      for (let between = start; between < line.line; between += 1) {
        if (
          !uncoveredKeys.has(
            `${line.snapshot}:${line.filePath}:${String(between)}`,
          )
        ) {
          return false;
        }
      }
      return true;
    });
    expect(
      answered,
      `${line.snapshot} line ${String(line.line)} of ${line.filePath} is uncovered but no gap names its region`,
    ).toBe(true);
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

  // A line labelled `seeded` must lie inside a declaration of a callable that was
  // actually seeded. Without this the assertion would only check that `mapSeeds`
  // labelled every line — and a bucket decided for the hunk as a whole would label an
  // outside line `seeded` and pass.
  //
  // Checked on **both** snapshots. It was head-only, which left a base-side loss able to
  // pass: a `modified` seed reports its head range, so base-side lines had nothing to
  // check against. Using the snapshot's own callable index supplies that range, and
  // covers deleted seeds, which exist only in base.
  const seededKeys = new Set(result.seeds.map((seed) => seed.key));
  for (const [snapshot, index] of [
    ["head", head],
    ["base", base],
  ] as const) {
    if (index === undefined) continue;
    const seededRanges = index.callables.filter((callable) =>
      seededKeys.has(callable.key),
    );
    for (const line of result.coverage) {
      if (line.bucket !== "seeded" || line.snapshot !== snapshot) continue;
      const inside = seededRanges.some(
        (callable) =>
          callable.filePath === line.filePath &&
          callable.ranges.some(
            (range) =>
              line.line >= range.startLine && line.line <= range.endLine,
          ),
      );
      expect(
        inside,
        `${snapshot} line ${String(line.line)} of ${line.filePath} is labelled "seeded" but lies inside no seeded callable's declaration`,
      ).toBe(true);
    }
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

/**
 * Whether a base-side uncovered line was replaced by an uncovered head line.
 *
 * Derived from the **diff**, not from anything `mapSeeds` reported, so it is an
 * independent account of which lines correspond.
 */
function hasUncoveredCounterpart(
  line: { snapshot: string; filePath: string; line: number },
  diff: DiffResult,
  uncoveredKeys: ReadonlySet<string>,
): boolean {
  for (const file of diff.files) {
    if (file.path !== line.filePath) continue;
    for (const hunk of file.hunks) {
      const offset = line.line - hunk.base.start;
      if (offset < 0 || offset >= hunk.base.count) continue;
      if (offset >= hunk.head.count) return false;
      return uncoveredKeys.has(
        `head:${file.path}:${String(hunk.head.start + offset)}`,
      );
    }
  }
  return false;
}
