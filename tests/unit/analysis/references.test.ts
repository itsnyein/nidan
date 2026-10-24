import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import {
  findUsages,
  type ReferenceResult,
  type SnapshotReferences,
} from "../../../src/analysis/references.js";
import { mapSeeds, type SeedResult } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import {
  explainOccurrences,
  unexplainedOf,
  type Occurrence,
} from "../../helpers/differential.js";
import { allFixtures } from "../../helpers/fixture-gaps.js";
import { JSX_COMPILER_OPTIONS, writeJsxShim } from "../../helpers/jsx-shim.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Outcome {
  readonly result: ReferenceResult;
  readonly seeds: SeedResult;
  readonly occurrences: readonly Occurrence[];
  /** Kept so a test can re-run the differential check against a doctored result. */
  readonly explain: (result: ReferenceResult) => Occurrence[];
}

async function analyze(repoPath: string): Promise<Outcome> {
  const repo = await createFixtureRepo(repoPath);
  cleanups.push(repo.cleanup);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  const diff = await diffCommits(repo.path, repo.baseSha, repo.headSha);
  const head: SnapshotReferences = {
    sourceFiles: pair.head.project.getSourceFiles(),
    index: enumerateCallables(pair.head.project.getSourceFiles(), repo.path),
  };
  const base: SnapshotReferences = {
    sourceFiles: pair.base.project.getSourceFiles(),
    index: enumerateCallables(pair.base.project.getSourceFiles(), repo.path),
  };
  const seeds = mapSeeds({ diff, base: base.index, head: head.index });
  const result = findUsages({
    seeds: seeds.seeds,
    base,
    head,
    repoRoot: repo.path,
  });

  // Run for **every** case this file analyzes, fixture or throwaway, so a case added
  // later is held to the differential check without anyone remembering to ask.
  const occurrences = explainOccurrences({
    result,
    seeds: seeds.seeds,
    gaps: seeds.gaps,
    base,
    head,
    repoRoot: repo.path,
  });

  const explain = (doctored: ReferenceResult): Occurrence[] =>
    explainOccurrences({
      result: doctored,
      seeds: seeds.seeds,
      gaps: seeds.gaps,
      base,
      head,
      repoRoot: repo.path,
    });

  return { result, seeds, occurrences, explain };
}

/**
 * The usages a fixture freezes, as comparable lines, or `undefined` when its record does
 * not mention usages at all.
 *
 * The distinction is the record contract, not a convenience: `"usages": []` asserts that
 * there are none, and an absent key asserts nothing. Treating the two the same would
 * either drop the five fixtures that freeze an empty list — the ones that catch
 * *over*-reporting — or demand an expectation from eleven records that never made one.
 */
function expectedUsages(name: string): string[] | undefined {
  const raw = readFileSync(
    join("tests", "fixtures", name, "expected.json"),
    "utf8",
  );
  // Cast justified: the frozen record contract an approved fixture task wrote. Every
  // field read here is present in every record that declares a usage.
  const parsed = JSON.parse(raw) as {
    expect: {
      seeds?: Array<{
        key: string;
        usages?: Array<{
          relation: string;
          from: string;
          site: { file: string; line: number };
          resolution: { status: string };
        }>;
      }>;
    };
  };
  const seeds = parsed.expect.seeds ?? [];
  if (!seeds.some((seed) => seed.usages !== undefined)) return undefined;

  return seeds
    .flatMap((seed) =>
      (seed.usages ?? []).map(
        (usage) =>
          `${seed.key} | ${usage.relation} | ${usage.from} | ${usage.site.file}:${String(usage.site.line)} | ${usage.resolution.status}`,
      ),
    )
    .sort();
}

function actualUsages(result: ReferenceResult): string[] {
  return result.usages
    .map(
      (usage) =>
        `${usage.seedKey} | ${usage.relation} | ${usage.from} | ${usage.filePath}:${String(usage.line)} | ${usage.resolution.status}`,
    )
    .sort();
}

/**
 * Fixtures whose record states behaviour that is **not implemented yet**.
 *
 * Each entry is asserted to fail below, not skipped. These also opt out of the
 * unexplained-occurrence sweep, which is unusual and deliberate: CommonJS discovery does
 * not exist, so the differential check correctly reports its call sites as unexplained.
 * That is the no-silent-miss guarantee working, not a defect — but it means the sweep
 * cannot hold these fixtures until the feature lands, so the pending entry asserts the
 * unexplained set **exactly** instead. A fixture that starts explaining more, or less,
 * fails here.
 */
const PENDING_FIXTURES = new Map<
  string,
  {
    usages: string[];
    unexplained: string[];
    /**
     * Set when the fixture still satisfies the repository-wide unexplained sweep.
     *
     * Pending does not always mean exempt. A fixture pinning a gap that does not exist
     * yet can explain every occurrence perfectly well — the missing gap is an absent
     * annotation, not a lost reference — and such a fixture must stay in the sweep.
     * Only a fixture whose references are genuinely unexplained may leave it.
     */
    inSweep?: true;
  }
>([
  [
    "usage-commonjs-require",
    {
      usages: [],
      unexplained: ["src/use.js:2", "src/use.js:5", "src/use.js:9"],
    },
  ],
  // Dispatch and untyped-receiver gaps are unimplemented. The two dispatch cases already
  // classify correctly and explain every occurrence — they are pinning an absent gap, not
  // a miss — so they stay in the repository-wide sweep. Only the untyped case opts out,
  // because its `any`-receiver call is genuinely unexplained until the gap exists.
  [
    "gap-interface-dispatch",
    {
      usages: [
        "src/store.ts :: FileStore :: method :: save | invoke | src/use.ts :: :: function :: persist | src/use.ts:5 | ambiguous",
        "src/store.ts :: FileStore :: method :: save | invoke | src/use.ts :: :: function :: persistConcrete | src/use.ts:9 | exact",
      ],
      unexplained: [],
      inSweep: true,
    },
  ],
  [
    "gap-override-dispatch",
    {
      usages: [
        "src/base.ts :: LoudReporter :: method :: render | invoke | src/use.ts :: :: function :: show | src/use.ts:4 | ambiguous",
      ],
      unexplained: [],
      inSweep: true,
    },
  ],
  [
    "gap-untyped-member-call",
    {
      usages: [
        "src/client.ts :: Client :: method :: send | invoke | src/use.ts :: :: function :: typed | src/use.ts:4 | exact",
      ],
      unexplained: ["src/use.ts:8"],
    },
  ],
  [
    "usage-commonjs-exports",
    {
      usages: [
        "src/lib.js :: :: function :: alpha | value-reference | src/lib.js :: module | src/lib.js:13 | exact",
        "src/lib.js :: :: function :: bravo | value-reference | src/lib.js :: module | src/lib.js:14 | exact",
      ],
      unexplained: [
        "src/lib.js:13",
        "src/lib.js:14",
        "src/use.js:4",
        "src/use.js:4",
      ],
    },
  ],
]);

describe("fixtures whose behaviour is not implemented yet", () => {
  it.each([...PENDING_FIXTURES])(
    "%s still reports what it reports today",
    async (name, expected) => {
      const outcome = await analyze(join("tests", "fixtures", name));

      // Stated exactly, so the entry cannot survive its own fix.
      expect(actualUsages(outcome.result)).toEqual(expected.usages);
      expect(
        unexplainedOf(outcome.occurrences)
          .map(
            (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
          )
          .sort(),
      ).toEqual([...expected.unexplained].sort());
      // The record is not empty, so this is pending work rather than a fixture that
      // expects nothing.
      expect(expectedUsages(name)?.length ?? 0).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

describe("usages against the frozen fixtures", () => {
  // **Every** fixture, not only the ones whose records declare a usage. Keying on record
  // content is the defect this repository has already paid for twice: a fixture that
  // freezes `"usages": []` is the one that catches *over*-reporting, and filtering on
  // "has at least one usage" removed exactly those from the check. A record that empties
  // itself would also have deleted its own assertion.
  const names = allFixtures();
  const declaring = names
    .filter((name) => expectedUsages(name) !== undefined)
    .filter((name) => !PENDING_FIXTURES.has(name));

  it("includes the fixtures that freeze an empty usage list", () => {
    // The property the enumeration exists for, asserted rather than assumed. A fixture
    // recording `"usages": []` is the one that catches over-reporting; selecting on
    // "has at least one usage" silently dropped every one of them.
    expect(
      declaring.filter((name) => expectedUsages(name)?.length === 0),
    ).toEqual([
      "identity-default-exports",
      "identity-nested-static-collision",
      "identity-static-vs-instance",
      "seed-added-deleted",
      "seed-comment-change",
    ]);
    expect(declaring.length).toBeGreaterThan(20);
  });

  it.each(declaring)(
    "%s produces exactly the usages it freezes",
    async (name) => {
      const outcome = await analyze(join("tests", "fixtures", name));

      expect(actualUsages(outcome.result)).toEqual(expectedUsages(name));
    },
    TIMEOUT_MS,
  );

  it.each(
    names.filter(
      (name) =>
        PENDING_FIXTURES.get(name)?.inSweep !== undefined ||
        !PENDING_FIXTURES.has(name),
    ),
  )(
    "%s leaves no occurrence of a seed name unexplained",
    async (name) => {
      const outcome = await analyze(join("tests", "fixtures", name));

      expect(
        unexplainedOf(outcome.occurrences).map(
          (occurrence) =>
            `${occurrence.filePath}:${String(occurrence.line)} ${occurrence.explanation.kind === "unexplained" ? occurrence.explanation.why : ""}`,
        ),
      ).toEqual([]);
      // The check has to have had something to do — but only where there is a seed to
      // scan for. A fixture with no seeds contributes no occurrences legitimately.
      if (outcome.seeds.seeds.length > 0) {
        expect(outcome.occurrences.length).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );
});

describe("the four equivalence variants agree", () => {
  it(
    "produces the same usage set in .ts, .tsx, .js and .jsx",
    async () => {
      const variants = ["ts", "tsx", "js", "jsx"];
      const normalized: string[][] = [];
      for (const variant of variants) {
        const outcome = await analyze(
          join("tests", "fixtures", `usage-equivalence-${variant}`),
        );
        // Strip the extension so the four become comparable. Nothing else is allowed to
        // differ: the four fixtures are byte-identical in source.
        normalized.push(
          actualUsages(outcome.result).map((usage) =>
            usage.replaceAll(`.${variant}`, ".EXT"),
          ),
        );
      }

      const [first] = normalized;
      expect(first).toBeDefined();
      for (const variant of normalized) expect(variant).toEqual(first);
      // Compared against the expectation too, so four identical wrong answers fail.
      expect(first).toEqual([
        "src/greet.EXT :: :: function :: greet | invoke | src/use.EXT :: :: function :: report | src/use.EXT:4 | exact",
      ]);
    },
    TIMEOUT_MS * 4,
  );
});

describe("a call through a string-literal element access", () => {
  // One class, one method, and three strings reading `send` — only one of which keys an
  // element access. The other two are what separate "is an element-access key" from
  // "contains the name", which a rule keyed on the text alone could not tell apart.
  const BASE = {
    "src/client.ts":
      "export class Client {\n  send(body: string): string {\n    return body;\n  }\n}\n",
    "src/use.ts":
      'import { Client } from "./client.js";\n\nexport function post(client: Client): string {\n  const label = "send";\n  return client["send"](label) + "send";\n}\n',
  };
  const HEAD = {
    ...BASE,
    "src/client.ts":
      "export class Client {\n  send(body: string): string {\n    return body.trim();\n  }\n}\n",
  };

  it(
    "classifies it as invoke, and leaves the two ordinary strings as text",
    async () => {
      // The input reaches the named case because the reference the compiler returns for
      // `client["send"](label)` is the **string literal**, whose parent is an element
      // access rather than a call — the one reference shape that arrives as a literal.
      // Lines 4 and 5 also contain `send` inside quotes and key nothing, so a rule that
      // matched on quoted text would report three usages here instead of one.
      const outcome = await analyze(
        await throwawayCase({ base: BASE, head: HEAD }),
      );

      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} from ${usage.from}`,
        ),
      ).toEqual(["invoke src/use.ts:5 from src/use.ts :: :: function :: post"]);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);
      // The two non-keys stay text. Asserting the kind, not merely the absence of a
      // usage: a rule that called them `different-symbol` would also report no usage.
      expect(
        outcome.occurrences
          .filter((occurrence) => occurrence.explanation.kind !== "usage")
          .filter((occurrence) => occurrence.filePath === "src/use.ts")
          .map((occurrence) => occurrence.explanation.kind),
      ).toEqual(["comment-or-string", "comment-or-string"]);
    },
    TIMEOUT_MS,
  );

  it(
    "leaves the occurrence unexplained when the usage is lost",
    async () => {
      // The half the classification test cannot reach. Before this, the harness resolved
      // an occurrence by the identifier at that position; a string literal is not one, so
      // it answered `comment-or-string` — right for a comment, wrong for a reference.
      // Dropping the usage therefore looked accounted for, exactly as a lost `super()`
      // once did.
      const outcome = await analyze(
        await throwawayCase({ base: BASE, head: HEAD }),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      const unexplained = unexplainedOf(
        outcome.explain({ ...outcome.result, usages: [] }),
      );

      expect(
        unexplained.map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/use.ts:5"]);
      expect(unexplained[0]?.explanation).toMatchObject({
        why: "a string-literal element access that resolves to the seed, which discovery neither reported nor filtered",
      });
    },
    TIMEOUT_MS,
  );
});

/**
 * Every element-access key shape, and whether it names a member at compile time.
 *
 * One table, two consumers. The classifier decides which keys become usages; the
 * differential check decides which keys it will hold discovery to. They are **separate
 * implementations on purpose** — a check that shared the classifier's logic could not
 * catch a bug in it — and this is what stops them drifting apart in silence.
 *
 * Each `line` is a line of the source below. Keep them in step.
 */
const KEY_SHAPES = [
  { line: 4, shape: "string literal", namesAMember: true },
  { line: 5, shape: "no-substitution template literal", namesAMember: true },
  {
    line: 6,
    shape: "template literal with a substitution",
    namesAMember: false,
  },
  { line: 8, shape: "identifier holding a literal type", namesAMember: false },
  { line: 9, shape: "computed expression", namesAMember: false },
  // Added after the milestone review, and the answer changed while it was being added.
  // The first ruling said a parenthesized key is the literal and both sides must unwrap
  // it; implementation showed the compiler's reference search returns **nothing** for
  // this spelling, so the classifier is never handed a node to classify. Ruled a
  // limitation instead. The row stays either way: a spelling absent from this table is
  // invisible to the agreement test, which is the one blind spot the design has.
  { line: 10, shape: "parenthesized string literal", namesAMember: false },
] as const;

const KEY_SHAPE_CASE = {
  "src/client.ts":
    "export class Client {\n  send(body: string): string {\n    return body;\n  }\n}\n",
  "src/use.ts":
    'import { Client } from "./client.js";\n' +
    "\n" +
    "export function post(client: Client, part: string, prefix: string): string {\n" +
    '  const stringKey = client["send"]("1");\n' +
    '  const templateKey = client[`send`]("2");\n' +
    '  const substituted = client[`${part}send` as "send"]("3");\n' +
    '  const send = "send" as const;\n' +
    '  const identifierKey = client[send]("4");\n' +
    '  const computedKey = client[(prefix + "send") as "send"]("5");\n' +
    '  const parenthesized = client[("send")]("6");\n' +
    "  return (\n" +
    "    stringKey +\n" +
    "    templateKey +\n" +
    "    substituted +\n" +
    "    identifierKey +\n" +
    "    computedKey +\n" +
    "    parenthesized\n" +
    "  );\n" +
    "}\n",
};

/**
 * Every heritage and annotation shape, and whether it is a **type** position.
 *
 * The second table, for the second rule that now has two independent implementations:
 * the analyzer's `isTypeOnlyPosition` decides what to filter, and the harness's
 * `sitsInTypePosition` decides whether a `type-only` record can be believed where it
 * landed. §10 requires both, and requires them to be tied by a table rather than by a
 * shared helper — the duplication without the table is how the two could agree on a
 * wrong answer, which is the shape of the defect that created this rule.
 */
const TYPE_POSITION_SHAPES = [
  { line: 4, shape: "class extends expression", isType: false },
  { line: 6, shape: "class implements clause", isType: true },
  { line: 10, shape: "interface extends clause", isType: true },
  { line: 14, shape: "parameter type annotation", isType: true },
] as const;

/**
 * Every shape names **the seed**, which is what makes the rows reachable.
 *
 * The occurrence scan searches for the seed's own name, so a type position mentioning
 * some other type contributes nothing to explain and the row would assert on an
 * occurrence that does not exist. An interface may extend a class, which is what lets
 * the same name appear in all four positions.
 */
const TYPE_POSITION_CASE = {
  "src/seed.ts":
    "export class Seed {\n  constructor(readonly url: string) {}\n}\n",
  "src/mix.ts":
    'import { Seed } from "./seed.js";\n\ntype Ctor = new (url: string) => Seed;\n\nexport function wrap(base: Ctor): Ctor {\n  return base;\n}\n',
  "src/use.ts":
    'import { Seed } from "./seed.js";\n' +
    'import { wrap } from "./mix.js";\n' +
    "\n" +
    "export class Wrapped extends wrap(Seed) {}\n" +
    "\n" +
    'export class Impl implements Seed {\n  readonly url = "u";\n}\n' +
    "\n" +
    "export interface Bigger extends Seed {\n  extra: string;\n}\n" +
    "\n" +
    "export function take(seed: Seed): string {\n  return seed.url;\n}\n",
};

describe("the classifier and the differential check agree on type positions", () => {
  it(
    "treats a class extends expression as a value position, on both sides",
    async () => {
      // One case, read twice. The analyzer's answer is what it filtered; the harness's
      // answer is whether it will believe a `type-only` record placed at that position.
      const outcome = await analyze(
        await throwawayCase({
          base: TYPE_POSITION_CASE,
          head: {
            ...TYPE_POSITION_CASE,
            "src/seed.ts":
              'export class Seed {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
            // `wrap` changes too, so the **call** in the extends expression is a seed
            // reference as well as its argument. Without this the table's first row is
            // never exercised and line 5 carries only one usage.
            "src/mix.ts":
              'import { Seed } from "./seed.js";\n\ntype Ctor = new (url: string) => Seed;\n\nexport function wrap(base: Ctor): Ctor {\n  void base;\n  return base;\n}\n',
          },
        }),
      );

      const valueLines = [
        ...new Set(
          TYPE_POSITION_SHAPES.filter((entry) => !entry.isType).map(
            (entry) => entry.line,
          ),
        ),
      ];

      // Side one: the analyzer reported the value-position references as usages rather
      // than filtering them.
      expect(
        outcome.result.usages
          .filter((usage) => usage.filePath === "src/use.ts")
          .map((usage) => usage.line)
          .sort(),
      ).toEqual([4, 4]);

      // Side two: a `type-only` record is refused exactly where the table says the
      // position is not a type position, and accepted where it says it is.
      const typeOnlyAt = (line: number) => {
        const occurrence = outcome.occurrences.find(
          (candidate) =>
            candidate.filePath === "src/use.ts" && candidate.line === line,
        );
        expect(
          occurrence,
          `no occurrence on line ${String(line)}`,
        ).toBeDefined();
        if (occurrence === undefined) return "missing";
        const doctored = {
          usages: outcome.result.usages.filter(
            (usage) =>
              !(usage.filePath === "src/use.ts" && usage.line === line),
          ),
          filtered: [
            ...outcome.result.filtered.filter(
              (reference) =>
                !(
                  reference.filePath === "src/use.ts" && reference.line === line
                ),
            ),
            {
              seedKey: occurrence.seedKey,
              reason: "type-only" as const,
              filePath: "src/use.ts",
              line,
              pos: occurrence.pos,
            },
          ],
        };
        const verdict = outcome
          .explain(doctored)
          .find(
            (candidate) =>
              candidate.filePath === "src/use.ts" &&
              candidate.pos === occurrence.pos,
          );
        return verdict?.explanation.kind ?? "missing";
      };

      for (const line of valueLines) {
        expect(
          typeOnlyAt(line),
          `line ${String(line)} is a value position`,
        ).toBe("unexplained");
      }
      for (const entry of TYPE_POSITION_SHAPES.filter((row) => row.isType)) {
        expect(
          typeOnlyAt(entry.line),
          `${entry.shape} on line ${String(entry.line)}`,
        ).toBe("filtered");
      }
    },
    TIMEOUT_MS,
  );
});

describe("the classifier and the differential check agree on key shapes", () => {
  it(
    "treats exactly the literal keys as references, on both sides",
    async () => {
      // The two sides are read from different places: `usages` comes from the analyzer,
      // `unexplained` from the harness. Both are compared against the same column of the
      // table, so a change to either implementation alone breaks this.
      const outcome = await analyze(
        await throwawayCase({
          base: KEY_SHAPE_CASE,
          head: {
            ...KEY_SHAPE_CASE,
            "src/client.ts":
              "export class Client {\n  send(body: string): string {\n    return body.trim();\n  }\n}\n",
          },
        }),
      );

      const namesAMember = KEY_SHAPES.filter((entry) => entry.namesAMember).map(
        (entry) => entry.line,
      );

      // Side one: what the classifier reported.
      expect(outcome.result.usages.map((usage) => usage.line).sort()).toEqual(
        namesAMember,
      );
      expect(
        outcome.result.usages.map(
          (usage) => `${usage.relation} ${usage.resolution.status}`,
        ),
      ).toEqual(namesAMember.map(() => "invoke exact"));

      // Side two: what the harness will hold discovery to. Dropping every usage makes it
      // name the keys it considers references — the same question, asked of the other
      // implementation.
      expect(
        unexplainedOf(outcome.explain({ ...outcome.result, usages: [] }))
          .map((occurrence) => occurrence.line)
          .sort(),
      ).toEqual(namesAMember);

      // And the harness actually looked at every shape. Without this the agreement could
      // be satisfied by a shape producing no occurrence at all, which would agree about
      // nothing.
      const seen = new Set(
        outcome.occurrences
          .filter((occurrence) => occurrence.filePath === "src/use.ts")
          .map((occurrence) => occurrence.line),
      );
      expect(
        KEY_SHAPES.filter((entry) => !seen.has(entry.line)).map(
          (entry) => entry.shape,
        ),
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("a call through a template-literal element access", () => {
  // Three backtick readings of `send`, one per line, and only the first keys an access:
  // a no-substitution key, a key **with** a substitution, and a plain template string.
  // The three are what separate the ruling's two halves from each other and from text.
  const BASE = {
    "src/client.ts":
      "export class Client {\n  send(body: string): string {\n    return body;\n  }\n}\n",
    "src/use.ts":
      'import { Client } from "./client.js";\n\nexport function post(client: Client, part: string): string {\n  const direct = client[`send`]("a");\n  const computed = client[`${part}send`] as unknown;\n  const note = `send`;\n  return direct + String(computed) + note;\n}\n',
  };
  const HEAD = {
    ...BASE,
    "src/client.ts":
      "export class Client {\n  send(body: string): string {\n    return body.trim();\n  }\n}\n",
  };

  it(
    "classifies a no-substitution key as invoke and ignores the other two",
    async () => {
      // Line 4 is the ruled case: a no-substitution template literal, which the compiler
      // resolves to the same member a string literal would. Line 5 carries a
      // substitution, so it is a different node kind naming no member — the compiler
      // returns no reference for it. Line 6 is a template string that is not a key at
      // all. Only the first may become a usage.
      const outcome = await analyze(
        await throwawayCase({ base: BASE, head: HEAD }),
      );

      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} ${usage.resolution.status}`,
        ),
      ).toEqual(["invoke src/use.ts:4 exact"]);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);
      // The substituted key and the plain template stay text. Asserted by kind, because
      // reporting them as `different-symbol` would also yield no usage.
      expect(
        outcome.occurrences
          .filter((occurrence) => occurrence.filePath === "src/use.ts")
          .filter((occurrence) => occurrence.explanation.kind !== "usage")
          .map((occurrence) => occurrence.explanation.kind),
      ).toEqual(["comment-or-string", "comment-or-string"]);
    },
    TIMEOUT_MS,
  );

  it(
    "leaves the occurrence unexplained when the usage is lost",
    async () => {
      // The harness half, for the backtick spelling. Without it the tripwire covers only
      // `"send"` and a lost usage at a backtick key still reads as accounted for.
      const outcome = await analyze(
        await throwawayCase({ base: BASE, head: HEAD }),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      const unexplained = unexplainedOf(
        outcome.explain({ ...outcome.result, usages: [] }),
      );

      expect(
        unexplained.map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/use.ts:4"]);
    },
    TIMEOUT_MS,
  );
});

describe("a reference reached through a property access", () => {
  it(
    "reports a member call as invoke rather than as a value reference",
    async () => {
      // The shape the name claims: the reference the compiler returns is the identifier
      // `send`, whose parent is the **property access**, not the call. Classifying from
      // that parent alone reads every member call as a value reference, and no frozen
      // fixture calls a method through a receiver — so deleting the walk to the
      // outermost access leaves the whole suite green. This is the test that notices.
      const base = {
        "src/client.ts":
          "export class Client {\n  send(body: string): string {\n    return body;\n  }\n}\n",
        "src/use.ts":
          'import { Client } from "./client.js";\n\nexport function post(client: Client): string {\n  return client.send("x");\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/client.ts":
              "export class Client {\n  send(body: string): string {\n    return body.trim();\n  }\n}\n",
          },
        }),
      );

      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} from ${usage.from}`,
        ),
      ).toEqual(["invoke src/use.ts:4 from src/use.ts :: :: function :: post"]);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "reports a member JSX tag as jsx-render rather than as a value reference",
    async () => {
      // The second spelling of the same shape, and the reason this is a separate test:
      // `<UI.Card />` parses as a JSX member expression, which ts-morph happens to
      // expose as a property access. The member-call test above would not notice if that
      // ever stopped being true. The frozen `layout-*` fixtures render `<Card />` — a
      // bare identifier tag, with no property access to walk.
      const base = {
        "src/ui.tsx":
          'import type { JSX } from "tiny-ui";\n\nexport function Card(props: { title: string }): JSX.Element {\n  return <span>{props.title}</span>;\n}\n',
        "src/app.tsx":
          'import type { JSX } from "tiny-ui";\nimport * as UI from "./ui.js";\n\nexport function App(): JSX.Element {\n  return <UI.Card title="hello" />;\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase(
          {
            base,
            head: {
              ...base,
              "src/ui.tsx":
                'import type { JSX } from "tiny-ui";\n\nexport function Card(props: { title: string }): JSX.Element {\n  return <span>{props.title.trim()}</span>;\n}\n',
            },
          },
          { jsx: true },
        ),
      );

      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} from ${usage.from}`,
        ),
      ).toEqual([
        "jsx-render src/app.tsx:5 from src/app.tsx :: :: function :: App",
      ]);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("filters", () => {
  it(
    "reports the two re-export specifiers of a two-hop barrel as filtered, not as usages",
    async () => {
      const outcome = await analyze(
        join("tests", "fixtures", "usage-barrel-two-hops"),
      );

      expect(outcome.result.usages).toHaveLength(1);
      // Asserting the reason, not merely the count. A filter that dropped export
      // specifiers into the declaration bucket would keep the usage count right while
      // the rule it names did nothing.
      expect(
        outcome.result.filtered
          .filter((reference) => reference.reason === "export-specifier")
          .map(
            (reference) => `${reference.filePath}:${String(reference.line)}`,
          ),
      ).toEqual(["src/index.ts:1", "src/inner/index.ts:1"]);
    },
    TIMEOUT_MS,
  );

  it(
    "filters a return-type annotation as type-only while reporting the construction beside it",
    async () => {
      const outcome = await analyze(
        join("tests", "fixtures", "usage-constructor-cross-file"),
      );

      // Both are in `src/use.ts`, three lines apart, so a missing type-only rule shows up
      // as a second usage *from the same callable* rather than as an obvious extra file.
      expect(
        outcome.result.filtered
          .filter((reference) => reference.reason === "type-only")
          .map(
            (reference) => `${reference.filePath}:${String(reference.line)}`,
          ),
      ).toEqual(["src/use.ts:3"]);
      expect(
        outcome.result.usages.filter(
          (usage) => usage.filePath === "src/use.ts",
        ),
      ).toHaveLength(1);
    },
    TIMEOUT_MS,
  );
});

describe("a subclass with no explicit constructor", () => {
  // Built outside `tests/fixtures/`, which is frozen: this shape has no approved fixture
  // yet, and its classification is deliberately unruled.
  const CONSTRUCTOR_CASE = {
    "src/client.ts":
      "export class Client {\n  constructor(readonly url: string) {}\n}\n",
    "src/retry.ts":
      'import { Client } from "./client.js";\n\nexport class RetryingClient extends Client {}\n',
  };

  it(
    "reports its extends clause as an implicit construct usage",
    async () => {
      const outcome = await analyze(
        await throwawayCase({
          base: CONSTRUCTOR_CASE,
          head: {
            ...CONSTRUCTOR_CASE,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );

      // `RetryingClient` declares no constructor, so there is no `super()` anywhere to
      // carry the construction. The clause itself is the construction.
      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} from ${usage.from} implicit=${String(usage.implicit === true)}`,
        ),
      ).toEqual([
        "construct src/retry.ts:3 from src/retry.ts :: RetryingClient :: constructor :: constructor implicit=true",
      ]);
      // And the clause is not *also* filtered, which would report the construction twice
      // if a later change started counting filtered clauses.
      expect(
        outcome.result.filtered.filter(
          (reference) => reference.reason === "heritage-clause",
        ),
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "attributes a nested class's super() to that class, not to the enclosing one",
    async () => {
      // Both classes extend `Client`, so the reference search returns both heritage
      // clauses and each collects its own `super()`. A scan that walked the whole
      // subtree collected the inner one twice — once correctly, once named for the
      // outer constructor, which reads as a second construction site that does not
      // exist.
      const base = {
        "src/client.ts":
          "export class Client {\n  constructor(readonly url: string) {}\n}\n",
        "src/retry.ts":
          'import { Client } from "./client.js";\n\nexport class RetryingClient extends Client {\n  constructor(url: string) {\n    super(url);\n    const Inner = class extends Client {\n      constructor() {\n        super("inner");\n      }\n    };\n    void Inner;\n  }\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );

      expect(
        outcome.result.usages.map(
          (usage) => `${usage.filePath}:${String(usage.line)}`,
        ),
      ).toEqual(["src/retry.ts:5", "src/retry.ts:8"]);
      // Each from its own constructor. The duplicate the subtree walk produced carried
      // the outer constructor's key for the inner call, so comparing the sites alone
      // would not have shown it.
      expect(
        new Set(outcome.result.usages.map((usage) => usage.from)).size,
      ).toBe(2);
    },
    TIMEOUT_MS,
  );

  it(
    "treats implements as a type-only reference, not as an unruled heritage clause",
    async () => {
      // `implements Client` is a heritage clause too, and routing every heritage clause
      // to the constructor rule parked it in the bucket reserved for the one shape
      // nobody has ruled on — while §9 already settles it as a type position.
      const base = {
        "src/client.ts":
          "export class Client {\n  constructor(readonly url: string) {}\n}\n",
        "src/fake.ts":
          'import { Client } from "./client.js";\n\nexport class FakeClient implements Client {\n  readonly url = "";\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );

      // No usage at all from `implements`: it is a type position, not a construction.
      expect(outcome.result.usages).toEqual([]);
      expect(
        outcome.result.filtered
          .filter((reference) => reference.filePath === "src/fake.ts")
          .map((reference) => `${reference.reason}:${String(reference.line)}`),
      ).toEqual(["import-specifier:1", "type-only:3"]);
    },
    TIMEOUT_MS,
  );

  it(
    "filters the clause once the subclass declares a constructor",
    async () => {
      // The other half of the rule, on the same shape plus one constructor. Without
      // this, "implicit construct usage" could be the answer for every heritage clause
      // and the first test would still pass — and the construction would be reported
      // twice, once at the clause and once at the `super()`.
      const withConstructor = {
        ...CONSTRUCTOR_CASE,
        "src/retry.ts":
          'import { Client } from "./client.js";\n\nexport class RetryingClient extends Client {\n  constructor(url: string) {\n    super(url);\n  }\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base: withConstructor,
          head: {
            ...withConstructor,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );

      expect(
        outcome.result.filtered.filter(
          (reference) => reference.reason === "heritage-clause",
        ),
      ).toHaveLength(1);
      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.relation} ${usage.filePath}:${String(usage.line)} from ${usage.from} implicit=${String(usage.implicit === true)}`,
        ),
      ).toEqual([
        "construct src/retry.ts:5 from src/retry.ts :: RetryingClient :: constructor :: constructor implicit=false",
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("a reference that does not resolve to the seed", () => {
  // Throwaway, not a fixture: `ambiguous` resolution has no approved fixture, and the
  // full semantics are later work. What is asserted here is the narrower rule this task
  // owns — no `exact` false positives.
  const INTERFACE_CASE = {
    "src/greeter.ts": "export interface Greeter {\n  greet(): string;\n}\n",
    "src/impl.ts":
      'import type { Greeter } from "./greeter.js";\n\nexport class Impl implements Greeter {\n  greet(): string {\n    return "hi";\n  }\n}\n',
    "src/use.ts":
      'import type { Greeter } from "./greeter.js";\n\nexport function run(g: Greeter): string {\n  return g.greet();\n}\n',
  };

  it(
    "is reported as ambiguous, naming the declaration it reached instead",
    async () => {
      const outcome = await analyze(
        await throwawayCase({
          base: INTERFACE_CASE,
          head: {
            ...INTERFACE_CASE,
            "src/impl.ts":
              'import type { Greeter } from "./greeter.js";\n\nexport class Impl implements Greeter {\n  greet(): string {\n    return "hello";\n  }\n}\n',
          },
        }),
      );

      // The call is typed as the interface, so it resolves to the interface member, not
      // to the changed implementation. Calling that `exact` would assert the caller
      // reaches this seed, which the types do not say.
      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.filePath}:${String(usage.line)} ${usage.resolution.status} ${JSON.stringify(usage.resolution.candidates)}`,
        ),
      ).toEqual(['src/use.ts:4 ambiguous ["src/greeter.ts:2"]']);
    },
    TIMEOUT_MS,
  );

  it(
    "filters a related symbol's own declaration instead of calling it a usage",
    async () => {
      // The interface member's declaration line is returned by the reference search but
      // is not a definition of the *searched* symbol, so the usual definition test does
      // not catch it. Reported as a usage it reads as a second call site; it is a line
      // that declares the method and calls nothing.
      const outcome = await analyze(
        await throwawayCase({
          base: INTERFACE_CASE,
          head: {
            ...INTERFACE_CASE,
            "src/impl.ts":
              'import type { Greeter } from "./greeter.js";\n\nexport class Impl implements Greeter {\n  greet(): string {\n    return "hello";\n  }\n}\n',
          },
        }),
      );

      expect(
        outcome.result.filtered
          .filter((reference) => reference.reason === "declaration")
          .map(
            (reference) => `${reference.filePath}:${String(reference.line)}`,
          ),
      ).toEqual(["src/greeter.ts:2", "src/impl.ts:4"]);
    },
    TIMEOUT_MS,
  );
});

describe("the differential check can fail", () => {
  it(
    "does not let another seed's call explain a lost super()",
    async () => {
      // The absorption hole again, in the one lookup that searches a **byte range**
      // rather than a position. A `super()` site carries no textual occurrence of the
      // class name, so the heritage tripwire asks "did anything get reported inside this
      // constructor" — and without the seed key, anything means any seed.
      //
      // The shape: a subclass constructor that calls `super()` **and** a second changed
      // callable. Both are seeds, so both have usages in the same byte range.
      const base = {
        "src/base.ts":
          "export class Base {\n  constructor(readonly url: string) {}\n}\n",
        "src/helper.ts":
          'export function helper(): string {\n  return "a";\n}\n',
        "src/sub.ts":
          'import { Base } from "./base.js";\nimport { helper } from "./helper.js";\n\nexport class Sub extends Base {\n  constructor() {\n    super("u");\n    void helper();\n  }\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/base.ts":
              'export class Base {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
            "src/helper.ts":
              'export function helper(): string {\n  return "a".trim();\n}\n',
          },
        }),
      );

      // Asserted, not assumed: two seeds, and both report a usage inside the same
      // constructor. Without that the rest of this test proves nothing.
      expect(outcome.seeds.seeds).toHaveLength(2);
      expect(
        outcome.result.usages.filter(
          (usage) => usage.filePath === "src/sub.ts",
        ),
      ).toHaveLength(2);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      // Drop only the base class's usages — exactly "lost `super()` detection". The
      // surviving `helper()` call sits in the same constructor and must not stand in
      // for it.
      const withoutSuper = {
        ...outcome.result,
        usages: outcome.result.usages.filter(
          (usage) => !usage.seedKey.includes("Base"),
        ),
      };

      expect(
        unexplainedOf(outcome.explain(withoutSuper)).map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/sub.ts:4"]);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses a type-only filter record for a value position",
    async () => {
      // The harness half of the mixin fix, and it needs its own test for a reason worth
      // stating: with the classifier fixed those references are **usages**, so no
      // `type-only` record exists at those positions and the guard never runs. Mutating
      // the guard away leaves the whole suite green. Only a doctored result — the
      // classifier regressed to exactly the old behaviour — exercises it.
      const outcome = await analyze(
        join("tests", "fixtures", "usage-value-position"),
      );
      const insideExtends = outcome.result.usages.filter(
        (usage) => usage.filePath === "src/use.ts" && usage.line === 5,
      );
      // Both of them: the mixin call and its argument. If this ever finds fewer, the
      // fixture changed and the rest of this test is measuring something else.
      expect(insideExtends).toHaveLength(2);

      const asOldBehaviour = {
        usages: outcome.result.usages.filter(
          (usage) => !insideExtends.includes(usage),
        ),
        filtered: [
          ...outcome.result.filtered,
          ...insideExtends.map((usage) => ({
            seedKey: usage.seedKey,
            reason: "type-only" as const,
            filePath: usage.filePath,
            line: usage.line,
            pos: usage.pos,
          })),
        ],
      };

      const unexplained = unexplainedOf(outcome.explain(asOldBehaviour));

      // "It was filtered" must not count as an explanation here: a class's `extends`
      // expression is ordinary code, so `type-only` cannot be true of it.
      expect(
        unexplained.map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/use.ts:5", "src/use.ts:5"]);
    },
    TIMEOUT_MS,
  );

  it(
    "does not let a renamed seed's usage explain the deleted one's",
    async () => {
      // The rename shape, which §7.2 makes an ordinary outcome: a rename is a delete plus
      // an add, so `alpha` (deleted, base) and `bravo` (added, head) are two seeds. The
      // names are the **same length** on purpose — the call site then sits at the same
      // offset in the same relative path in both snapshots, which is the only way the two
      // records can collide.
      const base = {
        "src/seed.ts": 'export function alpha(): string {\n  return "a";\n}\n',
        "src/use.ts":
          'import { alpha } from "./seed.js";\n\nexport const r = alpha();\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            "src/seed.ts":
              'export function bravo(): string {\n  return "a";\n}\n',
            "src/use.ts":
              'import { bravo } from "./seed.js";\n\nexport const r = bravo();\n',
          },
        }),
      );

      // The shape is what the test claims only if both seeds exist and both call sites
      // landed on the same line. Asserted, not assumed: a rename that produced one seed,
      // or offsets that differed, would make the rest of this test vacuous.
      expect(
        outcome.seeds.seeds
          .map((seed) => `${seed.change} ${seed.snapshot}`)
          .sort(),
      ).toEqual(["added head", "deleted base"]);
      const callSites = outcome.result.usages.filter(
        (usage) => usage.filePath === "src/use.ts",
      );
      expect(callSites).toHaveLength(2);
      expect(new Set(callSites.map((usage) => usage.pos)).size).toBe(1);
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      // Drop only the **deleted** seed's usage. Its occurrence must go unexplained; the
      // surviving usage belongs to the other seed and may not stand in for it.
      const withoutDeleted = {
        ...outcome.result,
        usages: outcome.result.usages.filter(
          (usage) => !usage.seedKey.includes("alpha"),
        ),
      };
      const unexplained = unexplainedOf(outcome.explain(withoutDeleted));

      expect(
        unexplained.map(
          (occurrence) =>
            `${occurrence.seedKey.split(" :: ").pop() ?? ""} ${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["alpha src/use.ts:3"]);
    },
    TIMEOUT_MS,
  );

  it(
    "turns a dropped usage into an unexplained occurrence",
    async () => {
      // The harness's own mutation. Everything else here asserts that nothing is
      // unexplained, which is satisfied by a harness that explains everything — so the
      // one thing that must be shown is that a real miss lands in `unexplained` rather
      // than in `different-symbol`, the bucket it would otherwise fall into.
      const outcome = await analyze(
        join("tests", "fixtures", "usage-equivalence-ts"),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      const withUsagesDropped = { ...outcome.result, usages: [] };
      const unexplained = unexplainedOf(outcome.explain(withUsagesDropped));

      expect(
        unexplained.map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/use.ts:4"]);
      expect(unexplained[0]?.explanation).toMatchObject({
        why: "resolves to the seed but discovery neither reported nor filtered it",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "turns a dropped constructor usage into an unexplained occurrence",
    async () => {
      // The same mutation on the constructor shape. Without it, the method case above
      // passes while constructor occurrences are resolved against the constructor's own
      // range — which `new Client()` lies outside — so every constructor reference falls
      // into `different-symbol` and "zero unexplained" holds while checking nothing.
      const outcome = await analyze(
        join("tests", "fixtures", "usage-constructor-cross-file"),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      const unexplained = unexplainedOf(
        outcome.explain({ ...outcome.result, usages: [] }),
      );

      // Two, not one. Dropping every usage drops the `super()` as well, so the `extends`
      // clause loses its explanation too — the tripwire and the occurrence check are
      // independent, and this mutation trips both.
      expect(
        unexplained
          .map(
            (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
          )
          .sort(),
      ).toEqual(["src/retry.ts:3", "src/use.ts:4"]);
    },
    TIMEOUT_MS,
  );

  it(
    "turns a lost super() detection into an unexplained extends clause",
    async () => {
      // The blind spot this tripwire closes. A `super()` site contains no textual
      // occurrence of the class name, so dropping `super()` detection is invisible to an
      // occurrence-based harness. The `extends` clause does carry the name, and being
      // *filtered* must not count as explaining it — that the clause was filtered says
      // nothing about whether the `super()` it delegates to was found.
      const base = {
        "src/client.ts":
          "export class Client {\n  constructor(readonly url: string) {}\n}\n",
        "src/retry.ts":
          'import { Client } from "./client.js";\n\nexport class RetryingClient extends Client {\n  constructor(url: string) {\n    super(url);\n  }\n}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      // Drop only the `super()` usage, leaving the filtered clause exactly as it was.
      const withoutSuper = {
        ...outcome.result,
        usages: outcome.result.usages.filter(
          (usage) => usage.filePath !== "src/retry.ts",
        ),
      };
      const unexplained = unexplainedOf(outcome.explain(withoutSuper));

      expect(
        unexplained.map(
          (occurrence) => `${occurrence.filePath}:${String(occurrence.line)}`,
        ),
      ).toEqual(["src/retry.ts:3"]);
      expect(unexplained[0]?.explanation).toMatchObject({
        why: "an extends clause whose subclass constructor reported no super() usage",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "turns a lost implicit construct usage into an unexplained extends clause",
    async () => {
      // The other half: with no constructor there is no `super()` to lose, so the only
      // thing that can explain the clause is the implicit usage at it.
      const base = {
        "src/client.ts":
          "export class Client {\n  constructor(readonly url: string) {}\n}\n",
        "src/plain.ts":
          'import { Client } from "./client.js";\n\nexport class PlainClient extends Client {}\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/client.ts":
              'export class Client {\n  constructor(readonly url: string) {\n    if (url === "") throw new Error("url is required");\n  }\n}\n',
          },
        }),
      );
      expect(unexplainedOf(outcome.occurrences)).toEqual([]);

      const unexplained = unexplainedOf(
        outcome.explain({ ...outcome.result, usages: [] }),
      );

      expect(unexplained.map((o) => `${o.filePath}:${String(o.line)}`)).toEqual(
        ["src/plain.ts:3"],
      );
      expect(unexplained[0]?.explanation).toMatchObject({
        why: "a subclass with no constructor, and no implicit construct usage reported for its extends clause",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "does not call an unrelated identifier of the same name a usage",
    async () => {
      // The other direction: a local `greet` in another file shares the text and must be
      // explained as a different symbol, not as an unexplained occurrence. Without this,
      // the rule above could be satisfied by calling every unmatched identifier a miss.
      const base = {
        "src/greet.ts": 'export function greet() {\n  return "Hello";\n}\n',
        "src/other.ts":
          'function greet() {\n  return "local";\n}\n\nexport const value = greet();\n',
      };
      const outcome = await analyze(
        await throwawayCase({
          base,
          head: {
            ...base,
            "src/greet.ts":
              'export function greet() {\n  return "Hello, world";\n}\n',
          },
        }),
      );

      expect(unexplainedOf(outcome.occurrences)).toEqual([]);
      expect(
        outcome.occurrences
          .filter(
            (occurrence) => occurrence.explanation.kind === "different-symbol",
          )
          .map((occurrence) => occurrence.filePath),
      ).toEqual(["src/other.ts", "src/other.ts"]);
    },
    TIMEOUT_MS,
  );
});

async function throwawayCase(
  files: {
    base: Record<string, string>;
    head: Record<string, string>;
  },
  // A `.tsx` case needs the compiler option and a JSX runtime to resolve against:
  // without them every tag is an error and the references come from a program that did
  // not type-check, which is not the thing the test means to measure. The shim mirrors
  // the one the `layout-*` fixtures use, so the two agree on what a working JSX case is.
  options: { jsx?: boolean } = {},
): Promise<string> {
  const caseDir = await mkdtemp(join(tmpdir(), "nidan-references-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  if (options.jsx === true) await writeJsxShim(caseDir);
  for (const [snapshot, entries] of Object.entries(files)) {
    await mkdir(join(caseDir, snapshot), { recursive: true });
    await writeFile(
      join(caseDir, snapshot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            ...(options.jsx === true ? JSX_COMPILER_OPTIONS : {}),
          },
          include: ["src"],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(caseDir, snapshot, "package.json"),
      `${JSON.stringify({ name: "case", private: true, type: "module" }, null, 2)}\n`,
    );
    for (const [path, contents] of Object.entries(entries)) {
      const absolute = join(caseDir, snapshot, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents);
    }
  }
  if (!existsSync(join(caseDir, "head"))) {
    throw new Error("throwaway case is missing its head snapshot");
  }
  return caseDir;
}
