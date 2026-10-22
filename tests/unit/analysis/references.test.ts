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

/** The usages a fixture freezes, as comparable lines. `relation` is not asserted here. */
function expectedUsages(name: string): string[] {
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
          from: string;
          site: { file: string; line: number };
          resolution: { status: string };
        }>;
      }>;
    };
  };
  return (parsed.expect.seeds ?? [])
    .flatMap((seed) =>
      (seed.usages ?? []).map(
        (usage) =>
          `${seed.key} | ${usage.from} | ${usage.site.file}:${String(usage.site.line)} | ${usage.resolution.status}`,
      ),
    )
    .sort();
}

function actualUsages(result: ReferenceResult): string[] {
  return result.usages
    .map(
      (usage) =>
        `${usage.seedKey} | ${usage.from} | ${usage.filePath}:${String(usage.line)} | ${usage.resolution.status}`,
    )
    .sort();
}

/**
 * Every fixture whose record declares at least one usage, derived from the directories.
 *
 * Enumerated rather than listed. A hand-written list is a second place to forget, and the
 * gap-record enumeration already showed what that costs: a fixture nothing loaded sat in
 * the tree verifying nothing for a whole milestone.
 */
function fixturesWithUsages(): string[] {
  return allFixtures().filter((name) => expectedUsages(name).length > 0);
}

describe("usages against the frozen fixtures", () => {
  const names = fixturesWithUsages();

  it("finds fixtures to check", () => {
    // Guards the enumeration itself. If the predicate ever stopped matching, every test
    // below would vanish and the file would still report success.
    expect(names.length).toBeGreaterThan(20);
  });

  it.each(names)(
    "%s produces exactly the usages it freezes",
    async (name) => {
      const outcome = await analyze(join("tests", "fixtures", name));

      expect(actualUsages(outcome.result)).toEqual(expectedUsages(name));
    },
    TIMEOUT_MS,
  );

  it.each(names)(
    "%s leaves no occurrence of a seed name unexplained",
    async (name) => {
      const outcome = await analyze(join("tests", "fixtures", name));

      expect(
        unexplainedOf(outcome.occurrences).map(
          (occurrence) =>
            `${occurrence.filePath}:${String(occurrence.line)} ${occurrence.explanation.kind === "unexplained" ? occurrence.explanation.why : ""}`,
        ),
      ).toEqual([]);
      // The check has to have had something to do. A fixture contributing zero
      // occurrences would pass the assertion above while checking nothing.
      expect(outcome.occurrences.length).toBeGreaterThan(0);
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
        "src/greet.EXT :: :: function :: greet | src/use.EXT :: :: function :: report | src/use.EXT:4 | exact",
      ]);
    },
    TIMEOUT_MS * 4,
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
    "surfaces through the differential check instead of being filtered away",
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
      // carry the construction. Filtering the heritage clause here would leave the
      // construction reported by nothing at all, which the ruling forbids in advance.
      expect(
        outcome.result.undecided.map(
          (reference) =>
            `${reference.reason} ${reference.filePath}:${String(reference.line)}`,
        ),
      ).toEqual(["implicit-constructor-heritage src/retry.ts:3"]);
      expect(
        outcome.result.filtered.filter(
          (reference) => reference.reason === "heritage-clause",
        ),
      ).toEqual([]);
      // And it is visible in the differential check rather than merely absent from it.
      expect(
        outcome.occurrences
          .filter((occurrence) => occurrence.explanation.kind === "undecided")
          .map((occurrence) => occurrence.filePath),
      ).toEqual(["src/retry.ts"]);
    },
    TIMEOUT_MS,
  );

  it(
    "filters the clause once the subclass declares a constructor",
    async () => {
      // The other half of the rule, on the same shape plus one constructor. Without this,
      // "undecided" could be the answer for every heritage clause and the first test
      // would still pass.
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

      expect(outcome.result.undecided).toEqual([]);
      expect(
        outcome.result.filtered.filter(
          (reference) => reference.reason === "heritage-clause",
        ),
      ).toHaveLength(1);
      expect(
        outcome.result.usages.map(
          (usage) =>
            `${usage.filePath}:${String(usage.line)} from ${usage.from}`,
        ),
      ).toEqual([
        "src/retry.ts:5 from src/retry.ts :: RetryingClient :: constructor :: constructor",
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

async function throwawayCase(files: {
  base: Record<string, string>;
  head: Record<string, string>;
}): Promise<string> {
  const caseDir = await mkdtemp(join(tmpdir(), "omen-references-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
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
