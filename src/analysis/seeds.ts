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
 * Per-hunk summary of the line-level accounting.
 *
 * Each bucket is **derived** from how the hunk's lines were classified, not decided for
 * the hunk as a whole: a hunk counts as seed-consumed when any of its lines is, even if
 * others are uncovered and produce a gap. The gap is extra information about that hunk,
 * not a second hunk.
 *
 * These counters are a summary, not the guarantee. The guarantee is `coverage`: a hunk
 * can balance here while lines inside it are dropped, which is exactly what each of M2's
 * silent misses did.
 */
export interface HunkAccounting {
  readonly totalHunks: number;
  readonly seedConsumed: number;
  /** Formatting only: a real hunk, deliberately not a seed and not a gap (§8.1). */
  readonly formattingFiltered: number;
  /**
   * Covered by an `ambiguous-identity` gap: every changed line sits inside a callable
   * whose key collides, so the change is reported by that gap rather than seeded.
   *
   * Its own bucket because such a hunk **does** have a gap, which `formattingFiltered`
   * explicitly does not.
   */
  readonly ambiguousCovered: number;
  readonly gapOnly: number;
}

export interface SeedResult {
  readonly seeds: readonly Seed[];
  readonly gaps: readonly SeedGap[];
  readonly ignoredFileCount: number;
  readonly accounting: HunkAccounting;
  /**
   * How every changed line was accounted for (§8.2 as amended). Reported so the
   * line-level invariant can be asserted from outside rather than taken on trust: the
   * hunk counters alone cannot show that no line was dropped.
   */
  readonly coverage: readonly CoveredLine[];
  /**
   * Keys that were attributed to a change but compared equal across snapshots, so they
   * are formatting-only rather than seeds (§8.1).
   *
   * Reported for the same reason as `coverage`: without it, an external check cannot
   * tell "this callable was examined and found unchanged" from "this callable was never
   * examined at all" — and that difference is exactly what a dropped owner looks like.
   */
  readonly formattingEqualKeys: readonly string[];
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

  // A change to a statement's shared tokens modifies **every** declarator it declares,
  // whichever line the diff touched (§8.2 as amended 2026-10-22). Attribution is per
  // changed line, so a sibling on an untouched line would otherwise have a changed
  // signature that no hunk points at — modified and unreported.
  addSharedTokenSiblings(touched, input, baseByKey, headByKey);

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

  // Line-level accounting (§8.2 as amended). Each changed line is classified on its own,
  // and the hunk buckets are derived from those classifications rather than decided for
  // the hunk as a whole. Every M2 silent miss was a hunk counted as accounted-for while
  // lines inside it were dropped; a per-line classification makes that shape impossible
  // to express.
  const lines: LineCoverage[] = [];
  for (const attribution of attributions) {
    lines.push(...coverageOf(attribution, input, seededKeys));
  }

  let seedConsumed = 0;
  let formattingFiltered = 0;
  let ambiguousCovered = 0;
  let gapOnly = 0;
  for (const attribution of attributions) {
    const own = lines.filter((line) => line.attribution === attribution);
    const uncovered = own.filter((line) => line.bucket === "uncovered");

    // A hunk that both seeds and leaves lines uncovered counts once, as seed-consumed:
    // the gap is extra information about that hunk, not a second hunk.
    //
    // A hunk whose lines sit inside colliding callables gets its own bucket. It used to
    // land in `formattingFiltered`, which contradicted that bucket's own meaning —
    // "deliberately not a seed and not a gap" — because such a hunk *does* have a gap,
    // the `ambiguous-identity` one. Nothing was lost, but the summary described the hunk
    // as filtered formatting when its text was substantive.
    if (own.some((line) => line.bucket === "seeded")) seedConsumed += 1;
    else if (uncovered.length > 0) gapOnly += 1;
    else if (own.some((line) => line.bucket === "ambiguous"))
      ambiguousCovered += 1;
    else formattingFiltered += 1;

    // One gap per **contiguous run** of uncovered lines, not one per hunk. A hunk can
    // leave two separate regions unaccounted for — a top-level line above a callable and
    // another below it — and a single gap names only one of them, leaving the other
    // changed but unreported. That is the same silent miss this task exists to close,
    // surviving at a finer grain than the hunk.
    for (const run of uncoveredRuns(attribution, uncovered)) {
      gaps.push(unmappedGap(attribution, run));
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
      ambiguousCovered,
      gapOnly,
    },
    formattingEqualKeys: [...filteredKeys].sort(),
    coverage: lines.map((line) => ({
      snapshot: line.snapshot,
      filePath: line.filePath,
      line: line.line,
      bucket: line.bucket,
    })),
  };
}

/**
 * How one changed line is accounted for.
 *
 * `seeded` and `formatting` mean the line lies inside a callable that was attributed to
 * it — seeded, or equal across snapshots. `uncovered` means no such callable exists, so
 * the line must be reported as a gap.
 */
export type CoverageBucket =
  "seeded" | "formatting" | "ambiguous" | "uncovered";

export interface CoveredLine {
  readonly snapshot: Snapshot;
  readonly filePath: string;
  readonly line: number;
  readonly bucket: CoverageBucket;
}

interface LineCoverage extends CoveredLine {
  readonly attribution: Attribution;
}

/**
 * Classifies every changed line of a hunk.
 *
 * Only sides that hold changed **text** produce lines: a pure insertion has none on the
 * base side, a pure deletion none on the head side. A zero-count range still decides
 * *ownership* for the opposite side's lines, through `attributeHunk`, but contributes no
 * line of its own because no text exists there to account for.
 *
 * The bucket comes from the same attribution the seeding path used, so coverage and
 * seeding cannot disagree. An invariant computed by a second, independent walk could
 * agree with the specification while diverging from the code — a new source of silent
 * error rather than a check on the existing one.
 */
function coverageOf(
  attribution: Attribution,
  input: MapSeedsInput,
  seededKeys: ReadonlySet<string>,
): LineCoverage[] {
  const sides: Array<[Snapshot, CallableIndex, Hunk["base"]]> = [];
  if (attribution.fileDiff.change !== "added") {
    sides.push(["base", input.base, attribution.hunk.base]);
  }
  if (attribution.fileDiff.change !== "deleted") {
    sides.push(["head", input.head, attribution.hunk.head]);
  }

  const covered: LineCoverage[] = [];
  for (const [snapshot, index, range] of sides) {
    const inFile = index.callables.filter(
      (callable) => callable.filePath === attribution.fileDiff.path,
    );
    for (const line of linesOf(range)) {
      const owners = innermostOwners(inFile, line)
        .map((owner) => owner.key)
        .filter((key) => attribution.keys.has(key));
      covered.push({
        attribution,
        snapshot,
        filePath: attribution.fileDiff.path,
        line,
        bucket: bucketFor(owners, seededKeys, index, attribution, line),
      });
    }
  }
  return covered;
}

/**
 * Adds the declarator siblings of any touched callable whose shared statement tokens
 * changed.
 *
 * Only when they actually changed: a sibling whose initializer alone was edited must not
 * drag the others in, which is why this keys on the shared tokens differing rather than
 * on the statement being multi-declarator.
 */
function addSharedTokenSiblings(
  touched: Set<string>,
  input: MapSeedsInput,
  baseByKey: ReadonlyMap<string, Callable>,
  headByKey: ReadonlyMap<string, Callable>,
): void {
  for (const key of [...touched]) {
    const inBase = baseByKey.get(key);
    const inHead = headByKey.get(key);
    if (inBase === undefined || inHead === undefined) continue;
    if (inBase.statementId === "" || inHead.statementId === "") continue;
    if (inBase.sharedTokens === inHead.sharedTokens) continue;

    for (const [index, id] of [
      [input.base, inBase.statementId],
      [input.head, inHead.statementId],
    ] as const) {
      for (const sibling of index.callables) {
        if (sibling.statementId === id) touched.add(sibling.key);
      }
    }
  }
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

  if (range.count === 0) return boundaryOwners(inFile, range);

  const keys = new Set<string>();
  for (const line of linesOf(range)) {
    for (const owner of innermostOwners(inFile, line)) keys.add(owner.key);
    // A line inside a declaring statement but outside every declarator — the keyword on
    // its own line — belongs to every callable that statement declares. Expansion from
    // already-touched keys cannot reach these: no declarator owns the line, so nothing is
    // touched to expand from, and the declarators are modified and unreported.
    for (const key of declaratorsOfStatementAt(inFile, line)) keys.add(key);
  }
  return [...keys];
}

/**
 * The owners of a zero-count range — a *position between two lines*, not a span (§8.2 as
 * amended 2026-10-21).
 *
 * The position belongs to a callable only when **both** adjacent lines lie inside that
 * same callable. A statement inserted between two functions sits next to one function's
 * last line and the next function's first, so it belongs to neither and the hunk becomes
 * an `unmapped-change` gap.
 *
 * Treating the position as touching both neighbours instead — the earlier reading —
 * attributed such an insertion to functions whose own text had not changed. They compared
 * equal, the hunk was filtered as formatting, and a real insertion produced no seed and no
 * gap while the accounting still balanced.
 */
function boundaryOwners(
  callables: readonly Callable[],
  range: Hunk["base"],
): string[] {
  // `start === 0` means "before the first line": there is no line before it, so no
  // callable can contain both sides and the change cannot belong to one.
  if (range.start === 0) return [];

  const after = new Set(
    innermostOwners(callables, range.start + 1).map((owner) => owner.key),
  );
  return innermostOwners(callables, range.start)
    .map((owner) => owner.key)
    .filter((key) => after.has(key));
}

/** The lines a non-empty range spans. A zero-count range spans none — see `boundaryOwners`. */
function linesOf(range: Hunk["base"]): number[] {
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
/**
 * Every declarator of a multi-declarator statement whose span contains the line.
 *
 * Used only when no declarator owns the line itself: the shared part of the statement —
 * the `let`/`const`/`var` keyword and its modifiers — belongs to all of them, and a
 * change there modifies every callable the statement declares (§8.2 as amended
 * 2026-10-22).
 */
function declaratorsOfStatementAt(
  callables: readonly Callable[],
  line: number,
): string[] {
  // Grouped by statement: the shared part is any line inside the statement's span that
  // no declarator's own range covers — the keyword on its own line. A line *inside* a
  // declarator is that declarator's alone, so an initializer edit never drags siblings
  // in. Independent of whether an enclosing callable also owns the line: in a class
  // method the method owns it, and the declarators still need seeding.
  const byStatement = new Map<string, Callable[]>();
  for (const callable of callables) {
    if (callable.statementId === "") continue;
    byStatement.set(callable.statementId, [
      ...(byStatement.get(callable.statementId) ?? []),
      callable,
    ]);
  }

  const keys: string[] = [];
  for (const group of byStatement.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const insideStatement =
      line >= first.statementStartLine && line <= first.statementEndLine;
    if (!insideStatement) continue;
    const insideSomeDeclarator = group.some((callable) =>
      callable.ranges.some(
        (range) => line >= range.startLine && line <= range.endLine,
      ),
    );
    if (insideSomeDeclarator) continue;
    for (const callable of group) keys.push(callable.key);
  }
  return keys;
}

function innermostOwners(
  callables: readonly Callable[],
  line: number,
): Callable[] {
  // Tested against each declaration's **own** range, not the hull. An overload set's
  // hull can contain top-level statements between non-contiguous signatures, and owning
  // them would make a real change compare equal inside an unchanged callable (§7.2 as
  // amended 2026-10-21).
  const containing = callables.filter((callable) =>
    callable.ranges.some(
      (range) => line >= range.startLine && line <= range.endLine,
    ),
  );

  return containing.filter(
    (candidate) =>
      !containing.some((other) => isStrictlyInside(other, candidate)),
  );
}

/**
 * Which bucket a changed line falls in.
 *
 * A line with no unique-identity owner is not automatically unaccounted for: if it lies
 * inside a callable whose key collides, the `ambiguous-identity` gap already describes
 * that code (§8.2, pre-ruling 3 of 2026-10-21). Reporting it again as an unmapped change
 * would claim nidan could not map something it mapped and then declined to seed.
 */
function bucketFor(
  owners: readonly string[],
  seededKeys: ReadonlySet<string>,
  index: CallableIndex,
  attribution: Attribution,
  line: number,
): CoverageBucket {
  if (owners.length > 0) {
    return owners.some((key) => seededKeys.has(key)) ? "seeded" : "formatting";
  }
  const insideCollision = index.collisions.some(
    (collision) =>
      collision.filePath === attribution.fileDiff.path &&
      collision.spans.some((span) => line >= span.start && line <= span.end),
  );
  return insideCollision ? "ambiguous" : "uncovered";
}

/** Whether `inner` sits strictly within `outer`, by character position. */
function isStrictlyInside(inner: Callable, outer: Callable): boolean {
  // Within **one** of the outer callable's declarations, not merely within its hull:
  // a callable sitting between two non-contiguous overload signatures is not nested
  // inside them.
  const within = outer.ranges.some(
    (range) => inner.startPos >= range.startPos && inner.endPos <= range.endPos,
  );
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

function uncoveredRuns(
  attribution: Attribution,
  uncovered: readonly CoveredLine[],
): CoveredLine[][] {
  if (uncovered.length === 0) return [];

  // §8.2 as ruled 2026-10-21: report every head-side uncovered run, plus every base-side
  // run that **no head-side gap accounts for**.
  //
  // A base line is accounted for only when it is the *replaced counterpart* of an
  // uncovered head line: Git lists a hunk's two sides in parallel, so the base line at
  // offset `n` was replaced by the head line at offset `n`. If that counterpart is itself
  // uncovered, the head gap already names the edit and a base gap would name it twice.
  //
  // A base line with no counterpart — offset beyond the head range, i.e. deleted text —
  // is never accounted for by a head gap, because there is no head line to carry it.
  // Those always get a base-side gap; skipping them is how a statement deleted beside a
  // modified callable came to be reported by nothing at all.
  const uncoveredHeadLines = new Set(
    uncovered
      .filter((line) => line.snapshot === "head")
      .map((line) => line.line),
  );

  const reported = uncovered.filter((line) => {
    if (line.snapshot === "head") return true;
    const offset = line.line - attribution.hunk.base.start;
    const hasCounterpart = offset >= 0 && offset < attribution.hunk.head.count;
    if (!hasCounterpart) return true;
    return !uncoveredHeadLines.has(attribution.hunk.head.start + offset);
  });

  // Runs rather than one gap per hunk: a hunk can leave two separate regions unaccounted
  // for, and a single gap names only the first. Grouped per snapshot, since a base run
  // and a head run are different reports.
  const runs: CoveredLine[][] = [];
  for (const snapshot of ["base", "head"] as const) {
    const ordered = reported
      .filter((line) => line.snapshot === snapshot)
      .sort((left, right) => left.line - right.line);
    let current: CoveredLine[] | undefined;
    for (const line of ordered) {
      if (
        current !== undefined &&
        current[current.length - 1]?.line === line.line - 1
      ) {
        current.push(line);
      } else {
        current = [line];
        runs.push(current);
      }
    }
  }
  return runs;
}

function unmappedGap(
  attribution: Attribution,
  run: readonly CoveredLine[],
): SeedGap {
  // The run's first line, so the gap names where the unaccounted change begins.
  const first = run[0];
  if (first === undefined) throw new Error("unmappedGap: empty run");
  return {
    kind: "unmapped-change",
    snapshot: first.snapshot,
    filePath: attribution.fileDiff.path,
    line: first.line,
    reasonCode: "no-enclosing-callable",
  };
}

/**
 * Orders gaps deterministically. Exported so its **contract** can be tested directly:
 * sorted output cannot distinguish a correct comparator from an inconsistent one that
 * V8's stable sort happens to order the same way, which is how the previous inconsistency
 * survived a test asserting sort order.
 */
export function compareGaps(left: SeedGap, right: SeedGap): number {
  // A **total order**: equal gaps compare 0, and every field participates. The previous
  // comparator never returned 0 and broke the final tie as `left.kind < right.kind ? -1 : 1`,
  // which returns 1 for *both* orderings of two gaps equal in (file, line, kind) — an
  // inconsistent comparator, for which the language leaves sort order unspecified. The tie
  // is reachable (a base-side and a head-side gap at the same line), so today's
  // determinism rests on the engine's sort implementation rather than on this function:
  // a latent cross-version risk for M5's byte-identical-JSON criterion.
  if (left.filePath !== right.filePath) {
    return left.filePath < right.filePath ? -1 : 1;
  }
  const byLine = firstLine(left) - firstLine(right);
  if (byLine !== 0) return byLine;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.snapshot !== right.snapshot) {
    return left.snapshot < right.snapshot ? -1 : 1;
  }
  // Same file, line, kind and snapshot: order by the whole site, so two ambiguous gaps
  // spanning different declaration sets still sort deterministically.
  // `key` participates too: two `ambiguous-identity` gaps in one file can share a line
  // and differ only by key, and without this they compare 0 in both directions — still
  // not a total order.
  const leftKey = keyOf(left);
  const rightKey = keyOf(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;

  // Code-unit comparison, never `localeCompare`: that is locale- and ICU-dependent, which
  // is exactly the engine-dependent ordering this function exists to remove, and
  // `decisions.md` §10 forbids locale-dependent ordering outright. Using it here was a
  // defect introduced by the very change meant to fix ordering.
  const leftSite = siteOf(left);
  const rightSite = siteOf(right);
  if (leftSite !== rightSite) return leftSite < rightSite ? -1 : 1;
  return 0;
}

/** The line a gap is anchored at. */
function firstLine(gap: SeedGap): number {
  return gap.kind === "unmapped-change" ? gap.line : (gap.lines[0] ?? 0);
}

/** The key a gap names, or `""` for kinds that name none. */
function keyOf(gap: SeedGap): string {
  return gap.kind === "ambiguous-identity" ? gap.key : "";
}

/** Every line a gap names, as one comparable string. */
function siteOf(gap: SeedGap): string {
  return gap.kind === "unmapped-change"
    ? String(gap.line)
    : gap.lines.map(String).join(",");
}
