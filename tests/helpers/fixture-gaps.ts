import { existsSync, readFileSync, readdirSync } from "node:fs";
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
export interface RecordedGap {
  readonly kind: string;
  readonly snapshot: string;
  readonly file: string;
  readonly reasonCode: string;
}

/**
 * Every fixture directory holding an `expected.json`.
 *
 * Keyed on the **fixture set**, never on record content. An earlier version enumerated
 * only fixtures whose record held at least one gap, which meant a record that emptied
 * itself deleted its own assertion: setting `repoWideGaps: []` on a fixture whose code
 * emits a gap dropped it from the list and left the suite green. A check that disappears
 * when the thing it checks changes is not a check.
 */
export function allFixtures(): string[] {
  return readdirSync(join("tests", "fixtures"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(join("tests", "fixtures", name, "expected.json")),
    )
    .sort();
}

/**
 * Asserts the gaps a fixture produced are exactly the gaps it records.
 *
 * Fixture gap expectations went unasserted through all of M2, and that was not a
 * theoretical gap. During T2.5 a manual sweep found `identity-collision` producing two
 * spurious `unmapped-change` gaps against a recorded expectation of **none**, while 242
 * tests passed: the code was wrong, the fixture was right, and nothing in the suite could
 * tell the difference.
 */
export function expectGapsMatchFixture(result: SeedResult, name: string): void {
  expectGapsEqual(
    result.gaps.map((gap) => ({
      kind: gap.kind,
      snapshot: gap.snapshot,
      file: gap.filePath,
      reasonCode: gap.reasonCode,
    })),
    recordedGaps(name),
    name,
  );
}

/**
 * Compares two gap collections as **multisets**.
 *
 * Multiset, not set: emitting the same gap twice is a real defect — it was literally the
 * `identity-collision` case, which produced two identical `unmapped-change` gaps — and
 * collapsing duplicates would hide it. Sorting the rendered strings and comparing the
 * arrays preserves multiplicity; converting to a `Set` anywhere here would not.
 *
 * Separated from file reading so both mismatch directions can be tested with synthetic
 * inputs, including duplicate-vs-single, which no current fixture can express.
 */
export function expectGapsEqual(
  actual: readonly RecordedGap[],
  expected: readonly RecordedGap[],
  label: string,
): void {
  expect(
    actual.map(render).sort(),
    `gaps for ${label} do not match its recorded expectation`,
  ).toEqual(expected.map(render).sort());
}

/**
 * The gaps a fixture's `expected.json` records, in **both** scopes.
 *
 * **No defaults.** A record missing `snapshot` or `site.file` is a test error naming the
 * fixture and the field, never a value filled in here: a default would silently compare
 * equal to whatever the code produced, making the record less strict than it looks while
 * appearing to assert something.
 */
export function recordedGaps(name: string): RecordedGap[] {
  const raw = readFileSync(
    join("tests", "fixtures", name, "expected.json"),
    "utf8",
  );
  // Cast justified: this is the frozen record contract an `E` task approved, and every
  // field is validated below rather than trusted. `expectedSeeds` casts the same shape.
  const parsed = JSON.parse(raw) as {
    expect?: {
      seeds?: Array<{
        gaps?: Array<{
          kind?: string;
          snapshot?: string;
          site?: { file?: string };
          reasonCode?: string;
        }>;
      }>;
      repoWideGaps?: Array<{
        kind?: string;
        snapshot?: string;
        site?: { file?: string };
        reasonCode?: string;
      }>;
    };
  };

  // An absent `expect` or `repoWideGaps` is a malformed record, not an assertion that
  // there are no gaps. Defaulting to `[]` would let a misspelled key read as "expects
  // nothing" — a record that asserts nothing while looking like one that does.
  return parseRecord(parsed, name);
}

/**
 * Validates a parsed `expected.json` and returns its recorded gaps.
 *
 * Split from the file read so a test can reach these rules with a synthetic record. The
 * test that named this behaviour previously passed a non-existent fixture, so
 * `readFileSync` threw `ENOENT` before any of it ran and a bare `.toThrow()` accepted
 * that — the rule it named was defended by nothing (§7a).
 */
export function parseRecord(
  parsed: {
    expect?: {
      seeds?: ReadonlyArray<{
        gaps?: ReadonlyArray<{
          kind?: string | undefined;
          snapshot?: string | undefined;
          site?: { file?: string | undefined } | undefined;
          reasonCode?: string | undefined;
        }>;
      }>;
      repoWideGaps?: ReadonlyArray<{
        kind?: string | undefined;
        snapshot?: string | undefined;
        site?: { file?: string | undefined } | undefined;
        reasonCode?: string | undefined;
      }>;
    };
  },
  name: string,
): RecordedGap[] {
  if (parsed.expect === undefined) {
    throw new Error(`${name}: expected.json has no "expect" object.`);
  }
  if (parsed.expect.repoWideGaps === undefined) {
    throw new Error(
      `${name}: expected.json has no "repoWideGaps" array. Record [] explicitly to ` +
        `assert that the fixture produces no gaps.`,
    );
  }
  // **Both** scopes. Reading only `repoWideGaps` is how three fixtures came to record a
  // seed-level gap that nothing compared: JSON shaped exactly like an expectation,
  // asserting nothing, and passing because passing was the only signal anyone looked at.
  // An absent `gaps` on a seed is fine — most records have no seed-level gaps to state —
  // but a present one is now read.
  const seedGaps = (parsed.expect.seeds ?? []).flatMap(
    (seed) => seed.gaps ?? [],
  );
  return [
    ...parseRecordedGaps(seedGaps, name),
    ...parseRecordedGaps(parsed.expect.repoWideGaps, name),
  ];
}

/**
 * Validates and narrows raw recorded gaps.
 *
 * Exported so the "no defaults" rule can be tested with synthetic records against the
 * **same** code path the fixture reader uses. A test that re-implemented the traversal
 * would check a copy of the rule rather than the rule.
 */
export function parseRecordedGaps(
  // `| undefined` spelled out because `exactOptionalPropertyTypes` distinguishes an
  // absent property from one explicitly set to undefined, and a malformed record can be
  // either.
  raw: ReadonlyArray<{
    kind?: string | undefined;
    snapshot?: string | undefined;
    site?: { file?: string | undefined } | undefined;
    reasonCode?: string | undefined;
  }>,
  name: string,
): RecordedGap[] {
  return raw.map((gap, index) => ({
    kind: required(gap.kind, name, index, "kind"),
    snapshot: required(gap.snapshot, name, index, "snapshot"),
    file: required(gap.site?.file, name, index, "site.file"),
    reasonCode: required(gap.reasonCode, name, index, "reasonCode"),
  }));
}

function required(
  value: unknown,
  name: string,
  index: number,
  field: string,
): string {
  // `typeof`, not `!== undefined`: a record carrying null, a number, or an object for a
  // field is malformed, and letting it through would compare a non-string against a
  // string and simply differ, reporting a mismatch rather than a broken record.
  if (typeof value !== "string") {
    throw new Error(
      `${name}: repoWideGaps[${String(index)}] has no string "${field}". ` +
        `Recorded gaps must state every field; a default would make the record less ` +
        `strict than it looks.`,
    );
  }
  return value;
}

/** One comparable line per gap, so a mismatch reads as a diff rather than object soup. */
function render(gap: RecordedGap): string {
  // NUL separator, which no field can contain. A space would make
  // `{file: "src/a b.ts", reasonCode: "x"}` compare equal to
  // `{file: "src/a", reasonCode: "b.ts x"}` — a boundary a path with a space can cross.
  return [gap.kind, gap.snapshot, gap.file, gap.reasonCode].join("\u0000");
}
