import type { DiffResult, FileDiff, Hunk } from "./diff.js";
import type { Callable, CallableIndex, IdentityCollision } from "./identity.js";

/** Which snapshot a seed's declaration comes from (§5.1). */
export type Snapshot = "base" | "head";

export type SeedChange = "added" | "deleted" | "modified";

export interface Seed {
  readonly key: string;
  readonly change: SeedChange;
  readonly filePath: string;
  /**
   * Where the declaration was read from: head for added and modified, base for deleted.
   * A deleted callable only exists in base, which is also where its callers are.
   */
  readonly snapshot: Snapshot;
  readonly startLine: number;
  readonly endLine: number;
}

export type SeedGap =
  | {
      readonly kind: "unmapped-change";
      readonly snapshot: Snapshot;
      readonly filePath: string;
      readonly line: number;
      readonly reasonCode: "no-enclosing-callable";
    }
  | {
      readonly kind: "ambiguous-identity";
      readonly snapshot: Snapshot;
      readonly filePath: string;
      readonly key: string;
      readonly lines: readonly number[];
      readonly reasonCode: "duplicate-structural-key";
    };

/**
 * Proof that no diff hunk was silently ignored.
 *
 * Every hunk in a source file lands in exactly one bucket. A hunk that produced both a
 * seed and a gap counts once, as seed-consumed — the gap is extra information about that
 * hunk, not a second hunk, and counting it twice would let the total balance while a
 * different hunk went missing.
 */
export interface HunkAccounting {
  readonly totalHunks: number;
  readonly seedConsumed: number;
  /** Formatting only: a real hunk, deliberately not a seed and not a gap (§8.1). */
  readonly formattingFiltered: number;
  readonly gapOnly: number;
}

export interface SeedResult {
  readonly seeds: readonly Seed[];
  readonly gaps: readonly SeedGap[];
  readonly ignoredFileCount: number;
  readonly accounting: HunkAccounting;
}

export interface MapSeedsInput {
  readonly diff: DiffResult;
  readonly base: CallableIndex;
  readonly head: CallableIndex;
}

/** A hunk and the callable keys it was attributed to, per snapshot. */
interface Attribution {
  readonly fileDiff: FileDiff;
  readonly hunk: Hunk;
  readonly keys: ReadonlySet<string>;
}

/**
 * Turns diff hunks and enumerated callables into seeds.
 *
 * The invariant this function exists to uphold is §8.2's: **no diff hunk is silently
 * ignored.** Every hunk becomes a seed, a documented filter, or a gap, and the returned
 * accounting is the evidence rather than a claim.
 */
export function mapSeeds(input: MapSeedsInput): SeedResult {
  const baseByKey = indexByKey(input.base);
  const headByKey = indexByKey(input.head);

  const attributions: Attribution[] = [];
  for (const fileDiff of input.diff.files) {
    for (const hunk of fileDiff.hunks) {
      attributions.push({
        fileDiff,
        hunk,
        keys: attributeHunk(fileDiff, hunk, input.base, input.head),
      });
    }
  }

  const touched = new Set<string>();
  for (const attribution of attributions) {
    for (const key of attribution.keys) touched.add(key);
  }

  const seeds: Seed[] = [];
  const filteredKeys = new Set<string>();
  for (const key of touched) {
    const seed = classify(key, baseByKey.get(key), headByKey.get(key));
    if (seed === undefined) filteredKeys.add(key);
    else seeds.push(seed);
  }
  const seededKeys = new Set(seeds.map((seed) => seed.key));

  // A collision usually exists in both snapshots. It is one fact about one key, so it is
  // reported once, attributed to head — the snapshot usages are taken from.
  const gaps: SeedGap[] = dedupeCollisions([
    ...collisionGaps(input.head.collisions, "head"),
    ...collisionGaps(input.base.collisions, "base"),
  ]);

  let seedConsumed = 0;
  let formattingFiltered = 0;
  let gapOnly = 0;
  for (const attribution of attributions) {
    const keys = [...attribution.keys];
    if (keys.some((key) => seededKeys.has(key))) {
      seedConsumed += 1;
    } else if (keys.some((key) => filteredKeys.has(key))) {
      formattingFiltered += 1;
    } else {
      gapOnly += 1;
      gaps.push(unmappedGap(attribution));
    }
  }

  return {
    seeds: seeds.sort((left, right) => (left.key < right.key ? -1 : 1)),
    gaps: gaps.sort(compareGaps),
    ignoredFileCount: input.diff.ignoredFileCount,
    accounting: {
      totalHunks: attributions.length,
      seedConsumed,
      formattingFiltered,
      gapOnly,
    },
  };
}

function indexByKey(index: CallableIndex): Map<string, Callable> {
  return new Map(index.callables.map((callable) => [callable.key, callable]));
}

/**
 * The callable keys a hunk is attributed to, looking at each snapshot the file exists in.
 *
 * A modified file is examined from both sides: the base range finds a callable that may
 * have been deleted, the head range one that may have been added. An added file has no
 * base side and a deleted file has no head side, per §5.1.
 */
function attributeHunk(
  fileDiff: FileDiff,
  hunk: Hunk,
  base: CallableIndex,
  head: CallableIndex,
): Set<string> {
  const keys = new Set<string>();

  if (fileDiff.change !== "added") {
    for (const key of attributedKeys(base, fileDiff.path, hunk.base)) {
      keys.add(key);
    }
  }
  if (fileDiff.change !== "deleted") {
    for (const key of attributedKeys(head, fileDiff.path, hunk.head)) {
      keys.add(key);
    }
  }

  return keys;
}

/**
 * The callables a changed range is attributed to.
 *
 * Attribution is **per changed line**, not per hunk. A single hunk routinely covers a
 * mixture: a statement belonging to an outer function and a nested function beneath it.
 * Attributing the hunk as a whole to one owner discards the other change — it gets
 * neither a seed nor a gap, while the accounting still balances, which is the failure
 * mode hunk accounting exists to catch.
 *
 * For each line, the owners are the innermost callables containing it — plural, because
 * one line can declare siblings. "Innermost" is **containment by character position**,
 * not by line span: an outer and an inner callable written on one line share a line span,
 * and a line-based test would call them siblings and seed both.
 *
 * Callables whose identity collides are absent from `index.callables`, so attribution
 * passes over them to the next enclosing candidate and their gap is reported separately
 * (§8.2 as amended).
 */
function attributedKeys(
  index: CallableIndex,
  filePath: string,
  range: Hunk["base"],
): string[] {
  const inFile = index.callables.filter(
    (callable) => callable.filePath === filePath,
  );
  if (inFile.length === 0) return [];

  const keys = new Set<string>();
  for (const line of changedLines(range)) {
    for (const owner of innermostOwners(inFile, line)) keys.add(owner.key);
  }
  return [...keys];
}

/**
 * The lines a range touches.
 *
 * A zero-count range is an insertion point rather than a span: Git reports it as the line
 * the new content follows. Both the line before and the line after are touched, because
 * inserting between two lines of a function body changed that function, and a callable
 * may start on either side of the insertion.
 */
function changedLines(range: Hunk["base"]): number[] {
  if (range.count === 0) {
    return range.start === 0 ? [1] : [range.start, range.start + 1];
  }
  return Array.from({ length: range.count }, (_, index) => range.start + index);
}

/**
 * The innermost callables whose line span contains the line, by position containment.
 *
 * Plural, because one line can hold **siblings**: `const a = () => 1, b = () => 2;`
 * declares two callables on one line, and so do two one-line function declarations.
 * Siblings are not inside one another, so reducing the line to a single owner would pick
 * one and silently discard the other — no seed, no gap, accounting still balanced.
 *
 * A candidate survives when no other containing callable is strictly inside it: that
 * drops enclosing callables while keeping every minimal one.
 */
function innermostOwners(
  callables: readonly Callable[],
  line: number,
): Callable[] {
  const containing = callables.filter(
    (callable) => line >= callable.startLine && line <= callable.endLine,
  );

  return containing.filter(
    (candidate) =>
      !containing.some((other) => isStrictlyInside(other, candidate)),
  );
}

/** Whether `inner` sits strictly within `outer`, by character position. */
function isStrictlyInside(inner: Callable, outer: Callable): boolean {
  const within =
    inner.startPos >= outer.startPos && inner.endPos <= outer.endPos;
  const identical =
    inner.startPos === outer.startPos && inner.endPos === outer.endPos;
  return within && !identical;
}

/**
 * Classifies a touched key, or returns undefined when the change is reformatting only.
 *
 * The formatting-only filter compares token signatures rather than text, so a rewrapped
 * argument list is not a seed while a changed comment is — §8.1 is explicit that a
 * comment edit counts, because a comment can state a contract callers rely on.
 */
function classify(
  key: string,
  inBase: Callable | undefined,
  inHead: Callable | undefined,
): Seed | undefined {
  if (inBase === undefined && inHead !== undefined) {
    return toSeed(key, "added", "head", inHead);
  }
  if (inHead === undefined && inBase !== undefined) {
    return toSeed(key, "deleted", "base", inBase);
  }
  if (inBase === undefined || inHead === undefined) return undefined;

  if (inBase.tokenSignature === inHead.tokenSignature) return undefined;
  return toSeed(key, "modified", "head", inHead);
}

function toSeed(
  key: string,
  change: SeedChange,
  snapshot: Snapshot,
  callable: Callable,
): Seed {
  return {
    key,
    change,
    filePath: callable.filePath,
    snapshot,
    startLine: callable.startLine,
    endLine: callable.endLine,
  };
}

function collisionGaps(
  collisions: readonly IdentityCollision[],
  snapshot: Snapshot,
): SeedGap[] {
  return collisions.map((collision) => ({
    kind: "ambiguous-identity" as const,
    snapshot,
    filePath: collision.filePath,
    key: collision.key,
    lines: collision.lines,
    reasonCode: "duplicate-structural-key" as const,
  }));
}

function dedupeCollisions(gaps: readonly SeedGap[]): SeedGap[] {
  const seen = new Set<string>();
  const unique: SeedGap[] = [];
  for (const gap of gaps) {
    if (gap.kind !== "ambiguous-identity") {
      unique.push(gap);
      continue;
    }
    if (seen.has(gap.key)) continue;
    seen.add(gap.key);
    unique.push(gap);
  }
  return unique;
}

function unmappedGap(attribution: Attribution): SeedGap {
  // Reported against the side that actually holds the changed lines. A deleted file has
  // no head side at all, and a pure deletion inside a modified file has an empty head
  // range — pointing at its head line would name code that did not change.
  const headIsEmpty = attribution.hunk.head.count === 0;
  const snapshot: Snapshot =
    attribution.fileDiff.change === "deleted" || headIsEmpty ? "base" : "head";
  const range =
    snapshot === "base" ? attribution.hunk.base : attribution.hunk.head;
  return {
    kind: "unmapped-change",
    snapshot,
    filePath: attribution.fileDiff.path,
    line: range.start,
    reasonCode: "no-enclosing-callable",
  };
}

function compareGaps(left: SeedGap, right: SeedGap): number {
  if (left.filePath !== right.filePath)
    return left.filePath < right.filePath ? -1 : 1;
  const leftLine =
    left.kind === "unmapped-change" ? left.line : (left.lines[0] ?? 0);
  const rightLine =
    right.kind === "unmapped-change" ? right.line : (right.lines[0] ?? 0);
  if (leftLine !== rightLine) return leftLine - rightLine;
  return left.kind < right.kind ? -1 : 1;
}
