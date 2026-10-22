import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import {
  findUsages,
  type SnapshotReferences,
} from "../../../src/analysis/references.js";
import { mapSeeds } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import {
  explainOccurrences,
  unexplainedOf,
} from "../../helpers/differential.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";
import {
  generateCase,
  randomFrom,
  rng,
  type GeneratedCase,
  type Shape,
} from "../../helpers/reference-generator.js";

const TIMEOUT_MS = 600_000;

/**
 * Fixed, so a failure is reproducible exactly. Never derived from the clock: a test that
 * fails once and cannot be reproduced trains everyone to re-run rather than investigate.
 */
const SEED = 0x5eed_7a11;

/** Each case builds a real repository, so this is modest. */
const CASES = 24;

/**
 * Opt-in locally, always on in CI — the dedicated randomized job sets it, and the guard
 * in `seeds-randomized.test.ts` fails there if it is ever dropped.
 */
const RANDOMIZED = process.env["NIDAN_RANDOMIZED"] === "1";

const TSCONFIG = JSON.stringify(
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
);

interface Outcome {
  readonly unexplained: readonly string[];
  /** Usages reported at a position inside an import or export declaration. */
  readonly inSpecifier: readonly string[];
  readonly diagnostics: readonly string[];
  readonly occurrences: number;
  readonly seeds: number;
  readonly usages: number;
}

/**
 * Builds, analyses, and **releases** one generated case.
 *
 * Each case is torn down before the next is built. Accumulating them until the end of the
 * test retains two full type-checked programs per case, which exhausted the default heap
 * and aborted the worker — a failure that looks like flakiness and is not. Holding one at
 * a time is also what makes a failure reproducible: the case that fails is the only one
 * in memory when it does.
 */
async function runCase(generated: GeneratedCase): Promise<Outcome> {
  const caseDir = await mkdtemp(join(tmpdir(), "nidan-references-"));
  try {
    return await analyseCase(generated, caseDir);
  } finally {
    await rm(caseDir, { recursive: true, force: true });
  }
}

async function analyseCase(
  generated: GeneratedCase,
  caseDir: string,
): Promise<Outcome> {
  for (const [snapshot, files] of [
    ["base", generated.base],
    ["head", generated.head],
  ] as const) {
    await mkdir(join(caseDir, snapshot, "src"), { recursive: true });
    await writeFile(join(caseDir, snapshot, "tsconfig.json"), `${TSCONFIG}\n`);
    await writeFile(
      join(caseDir, snapshot, "package.json"),
      `${JSON.stringify({ name: "case", private: true, type: "module" })}\n`,
    );
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(join(caseDir, snapshot, path), contents);
    }
  }

  const repo = await createFixtureRepo(caseDir);
  try {
    return await analyseRepo(repo);
  } finally {
    await repo.cleanup();
  }
}

async function analyseRepo(repo: {
  path: string;
  baseSha: string;
  headSha: string;
}): Promise<Outcome> {
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
  const occurrences = explainOccurrences({
    result,
    seeds: seeds.seeds,
    gaps: seeds.gaps,
    base,
    head,
    repoRoot: repo.path,
  });

  // The differential check catches **under**-reporting: an occurrence nothing explained.
  // It cannot catch the opposite, because an extra usage explains its own occurrence. A
  // usage reported inside an import or export declaration is the over-reporting shape
  // that matters here, and it is decidable from the position alone — no expected count,
  // so it survives the classification work that will change those counts.
  const inSpecifier = result.usages
    .filter((usage) => {
      const file = pair.head.project
        .getSourceFiles()
        .find((candidate) =>
          candidate
            .getFilePath()
            .replace(/\\/gu, "/")
            .endsWith(`/${usage.filePath}`),
        );
      const node = file?.getDescendantAtPos(usage.pos);
      return (
        node?.getFirstAncestor(
          (ancestor) =>
            Node.isImportDeclaration(ancestor) ||
            Node.isExportDeclaration(ancestor),
        ) !== undefined
      );
    })
    .map((usage) => `${usage.filePath}:${String(usage.line)}`);

  return {
    inSpecifier,
    unexplained: unexplainedOf(occurrences).map(
      (occurrence) =>
        `${occurrence.filePath}:${String(occurrence.line)} — ${
          occurrence.explanation.kind === "unexplained"
            ? occurrence.explanation.why
            : ""
        }`,
    ),
    diagnostics: [
      ...pair.base.project.getPreEmitDiagnostics(),
      ...pair.head.project.getPreEmitDiagnostics(),
    ].map((diagnostic) => {
      // `getMessageText` returns a chain for multi-part messages; stringifying it
      // directly yields "[object Object]", which would make a failing case unreadable.
      const text = diagnostic.getMessageText();
      return typeof text === "string" ? text : text.getMessageText();
    }),
    occurrences: occurrences.length,
    seeds: seeds.seeds.length,
    usages: result.usages.length,
  };
}

describe("the generated reference suite is not silently disabled", () => {
  it("runs whenever CI runs", () => {
    // Every randomized file guards itself. The seeding suite's guard proves CI sets the
    // flag, but it cannot prove that *this* file is in the dedicated job's selection — a
    // file excluded from the main run and never added to the randomized one runs nowhere
    // and reports nothing, which is the failure mode worth a test of its own.
    expect(
      process.env["CI"] === undefined || RANDOMIZED,
      "CI must set NIDAN_RANDOMIZED=1 — the generated reference suite must never silently stop running",
    ).toBe(true);
  });
});

describe.skipIf(!RANDOMIZED)("generated reference cases", () => {
  it(
    `leave nothing unexplained across ${String(CASES)} cases from seed 0x${SEED.toString(16)}`,
    async () => {
      const random = randomFrom(rng(SEED));

      for (let index = 0; index < CASES; index += 1) {
        const generated = generateCase(random, index);
        const outcome = await runCase(generated);
        const where = [
          `case:  ${String(index)} of ${String(CASES)}`,
          `shape: ${generated.description}`,
          `seed:  0x${SEED.toString(16)}`,
        ].join("\n  ");

        // A case that does not compile is testing the compiler's error recovery, not
        // reference discovery, and would make any result here meaningless.
        expect(outcome.diagnostics, `diagnostics\n  ${where}`).toEqual([]);
        expect(outcome.unexplained, `unexplained\n  ${where}`).toEqual([]);
        expect(
          outcome.inSpecifier,
          `usage reported inside an import or export declaration\n  ${where}`,
        ).toEqual([]);
        // The invariant has to have had something to check. A case producing no seed, or
        // no occurrence of its name, satisfies "nothing unexplained" vacuously.
        expect(outcome.seeds, `no seed\n  ${where}`).toBeGreaterThan(0);
        // Counted from what the generator **built**, never from what omen reported. This
        // is the only check here that catches over-reporting precisely: the differential
        // invariant cannot see an extra usage, because an extra usage explains its own
        // occurrence.
        expect(outcome.usages, `usage count\n  ${where}`).toBe(
          generated.expectedUsages,
        );
        expect(
          outcome.occurrences,
          `no occurrences\n  ${where}`,
        ).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );
});

describe("the generator reaches the shapes it claims", () => {
  it("covers every declared shape across the generated cases", () => {
    // Runs without the flag: it generates sources but builds no repository, so it is
    // cheap, and the coverage claim should not be the thing that goes unchecked locally.
    //
    // Asserted against the full list rather than a count. A generator that silently
    // stopped producing one shape would leave the suite green and the coverage gone,
    // which is the failure this whole file exists to make visible.
    const random = randomFrom(rng(SEED));
    const seen = new Set<Shape>();
    for (let index = 0; index < CASES; index += 1) {
      for (const shape of generateCase(random, index).shapes) seen.add(shape);
    }

    const declared: readonly Shape[] = [
      "comment-occurrence",
      "direct-call",
      "interface-typed-receiver",
      "one-hop",
      "same-name-other-module",
      "shadowed-local",
      "string-occurrence",
      "subclass-with-constructor",
      "subclass-without-constructor",
      "two-hops",
      "type-position",
    ];

    expect([...seen].sort()).toEqual([...declared].sort());
  });

  it("puts the shapes in the case description, so a failure names them", () => {
    // The failure message is the only thing a reader gets when a generated case breaks.
    // If the description did not carry the shape, reproducing it would mean re-deriving
    // the generator's state by hand.
    const random = randomFrom(rng(SEED));
    const descriptions = Array.from({ length: CASES }, (_unused, index) =>
      generateCase(random, index).description.split(", "),
    );

    for (const parts of descriptions) {
      expect(parts[0]).toMatch(/^(function|class|method)#\d+$/u);
      expect(parts[1]).toMatch(/^hops=[012]$/u);
    }
  });
});
