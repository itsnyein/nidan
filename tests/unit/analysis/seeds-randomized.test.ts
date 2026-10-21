import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits } from "../../../src/analysis/diff.js";
import { enumerateCallables } from "../../../src/analysis/identity.js";
import { mapSeeds } from "../../../src/analysis/seeds.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";
import { expectEveryChangedLineAccounted } from "../../helpers/line-coverage.js";

const TIMEOUT_MS = 600_000;

/**
 * Fixed, so a failure is reproducible exactly. Never derive this from the clock: a test
 * that fails once and then cannot be reproduced is worse than no test, because it trains
 * everyone to re-run rather than investigate.
 */
const SEED = 0x5eed_1234;

/** How many generated cases to run. Each builds a real repository, so this is modest. */
const CASES = 40;

/**
 * The generated cases build 40 real Git repositories, which dominates local test time, so
 * they run only when asked for. **CI always asks** — see the guard below.
 *
 * Opt-in rather than opt-out: a developer who has never heard of this flag gets a fast
 * suite, and the one place that must never skip it is the one place that sets it.
 */
const RANDOMIZED = process.env["OMEN_RANDOMIZED"] === "1";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      allowJs: true,
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  },
  null,
  2,
);

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * Written out rather than taken from a dependency: `AGENTS.md` forbids adding one for
 * this, and `Math.random` cannot be seeded, which would make failures irreproducible.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Random {
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

function randomFrom(next: () => number): Random {
  return {
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      // The index is always in range; the check is for the compiler, which cannot know.
      if (item === undefined) throw new Error("empty pick");
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

/**
 * The line shapes the generator can emit.
 *
 * Chosen so the three shapes that produced M2's silent misses are all reachable:
 *
 * - **Siblings on one line** — `sibling-pair` emits two callables in one statement on a
 *   single line, the shape that defeated per-line attribution reduced to one owner.
 * - **Boundary insertions** — `top-level` lines between functions, combined with the
 *   `insert` and `delete` edits below, put a zero-count range between two scopes.
 * - **Substantive text beside a callable change** — `top-level` adjacent to `function`,
 *   with both edited, is the mixed-hunk shape.
 *
 * A generator that could not reach these would not be exercising the class this task
 * exists to close, however many cases it ran.
 */
type Shape = "function" | "nested" | "sibling-pair" | "top-level" | "type-only";

const SHAPES: readonly Shape[] = [
  "function",
  "nested",
  "sibling-pair",
  "top-level",
  "type-only",
];

/** One declaration, as the lines it occupies. */
function emit(shape: Shape, index: number, variant: number): string[] {
  switch (shape) {
    case "function":
      return [
        `export function fn${String(index)}(a: number): number {`,
        `  return a + ${String(variant)};`,
        `}`,
      ];
    case "nested":
      return [
        `export function outer${String(index)}(): number {`,
        `  const local = ${String(variant)};`,
        `  function inner${String(index)}(): number {`,
        `    return ${String(variant)};`,
        `  }`,
        `  return local + inner${String(index)}();`,
        `}`,
      ];
    case "sibling-pair":
      // Both on one line: the shape where two callables share a line span.
      return [
        `export const a${String(index)} = () => ${String(variant)}, b${String(index)} = () => ${String(variant + 1)};`,
      ];
    case "top-level":
      return [`export const C${String(index)} = ${String(variant)};`];
    case "type-only":
      return [
        `export interface T${String(index)} { readonly v: ${String(variant)} }`,
      ];
  }
}

interface Generated {
  readonly base: string;
  readonly head: string;
  readonly description: string;
}

/** Builds a small file and an edited version of it. */
function generateCase(random: Random): Generated {
  const count = 2 + random.int(4);
  const shapes = Array.from({ length: count }, () => random.pick(SHAPES));

  const baseLines: string[] = [];
  const headLines: string[] = [];
  const edits: string[] = [];

  for (const [index, shape] of shapes.entries()) {
    const base = emit(shape, index, 1);
    const edit = random.pick(["none", "modify", "insert", "delete"] as const);

    baseLines.push(...base);
    if (edit === "none") {
      headLines.push(...base);
      continue;
    }
    if (edit === "modify") {
      headLines.push(...emit(shape, index, 2));
      edits.push(`${shape}#${String(index)}: modify`);
      continue;
    }
    if (edit === "insert") {
      // A pure insertion immediately before the declaration: a zero-count range whose
      // adjacent lines straddle a scope boundary.
      headLines.push(`export const INS${String(index)} = 0;`, ...base);
      edits.push(`${shape}#${String(index)}: insert-before`);
      continue;
    }
    // delete: present in base, absent from head.
    edits.push(`${shape}#${String(index)}: delete`);
  }

  // Guarantee at least one change, or the case asserts nothing.
  if (edits.length === 0) {
    headLines.push(`export const TAIL = 1;`);
    edits.push("tail: insert");
  }

  return {
    base: `${baseLines.join("\n")}\n`,
    head: `${headLines.join("\n")}\n`,
    description: edits.join(", "),
  };
}

async function runCase(generated: Generated): Promise<void> {
  const caseDir = await mkdtemp(join(tmpdir(), "omen-rand-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  for (const [snapshot, contents] of [
    ["base", generated.base],
    ["head", generated.head],
  ] as const) {
    await mkdir(join(caseDir, snapshot, "src"), { recursive: true });
    await writeFile(join(caseDir, snapshot, "tsconfig.json"), `${TSCONFIG}\n`);
    await writeFile(join(caseDir, snapshot, "src", "a.ts"), contents);
  }

  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  const diff = await diffCommits(repo.path, repo.baseSha, repo.headSha);
  const head = enumerateCallables(
    pair.head.project.getSourceFiles(),
    repo.path,
  );
  const base = enumerateCallables(
    pair.base.project.getSourceFiles(),
    repo.path,
  );
  const result = mapSeeds({ diff, base, head });

  expectEveryChangedLineAccounted(result, diff, head, base);
}

describe("the randomized suite is not silently disabled", () => {
  it("runs whenever CI runs", () => {
    // Asserts the condition the suite actually runs under, not merely that the workflow
    // mentions the variable: a workflow-level grep would pass while the tests skipped for
    // some other reason. If CI ever stops setting `OMEN_RANDOMIZED=1`, this fails there
    // and stays quiet locally.
    //
    // Without it, gating would be a textbook structural defect (`decisions.md` §7a): the
    // suite could stop checking anything and still report success.
    expect(
      process.env["CI"] === undefined || RANDOMIZED,
      "CI must set OMEN_RANDOMIZED=1 — the randomized suite must never silently stop running",
    ).toBe(true);
  });
});

describe.skipIf(!RANDOMIZED)(
  "the line-level invariant holds for generated cases",
  () => {
    it(
      `holds for ${String(CASES)} cases from seed 0x${SEED.toString(16)}`,
      async () => {
        const random = randomFrom(rng(SEED));

        for (let index = 0; index < CASES; index += 1) {
          const generated = generateCase(random);
          try {
            await runCase(generated);
          } catch (cause) {
            // Everything needed to reproduce, in the failure itself: re-running the suite
            // is not a diagnosis, and a generated case that cannot be reconstructed from
            // the output is a dead end for whoever picks this up.
            throw new Error(
              [
                `Line-level invariant failed.`,
                `  seed:  0x${SEED.toString(16)}`,
                `  case:  ${String(index)} of ${String(CASES)}`,
                `  edits: ${generated.description}`,
                `  base:\n${indent(generated.base)}`,
                `  head:\n${indent(generated.head)}`,
              ].join("\n"),
              { cause },
            );
          }
        }
      },
      TIMEOUT_MS,
    );
  },
);

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    | ${line}`)
    .join("\n");
}

describe("the generator reaches the shapes it claims", () => {
  it("generates the three shapes that caused M2's silent misses", () => {
    // The generator is only worth running if it can reach the failures this task closes.
    //
    // The predicates below test what was **edited**, not merely what was emitted. An
    // earlier version accepted an unedited sibling pair and non-adjacent top-level and
    // function edits, so it claimed coverage the generated cases did not have — the same
    // "passes for the wrong reason" failure this whole task exists to end, in the test
    // that was supposed to guard against it.
    const random = randomFrom(rng(SEED));
    const seen = new Set<string>();
    for (let index = 0; index < CASES; index += 1) {
      const { description } = generateCase(random);
      const edits = description.split(", ");

      // A sibling pair that was actually changed, not one that merely exists.
      if (edits.some((edit) => edit.startsWith("sibling-pair#")))
        seen.add("siblings-on-one-line");

      if (edits.some((edit) => edit.endsWith("insert-before")))
        seen.add("boundary-insertion");

      // Adjacent declarations, both edited: the mixed-hunk shape. Non-adjacent edits land
      // in separate hunks and do not exercise it at all.
      for (const [first, second] of pairs(edits)) {
        const firstIndex = Number(first.split("#")[1]?.split(":")[0]);
        const secondIndex = Number(second.split("#")[1]?.split(":")[0]);
        if (secondIndex !== firstIndex + 1) continue;
        const involvesTopLevel =
          first.startsWith("top-level#") || second.startsWith("top-level#");
        const involvesCallable =
          first.startsWith("function#") || second.startsWith("function#");
        if (involvesTopLevel && involvesCallable)
          seen.add("substantive-text-beside-a-callable");
      }
    }

    expect([...seen].sort()).toEqual([
      "boundary-insertion",
      "siblings-on-one-line",
      "substantive-text-beside-a-callable",
    ]);
  });
});

/** Consecutive pairs of a list. */
function pairs(items: readonly string[]): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (let index = 0; index + 1 < items.length; index += 1) {
    const first = items[index];
    const second = items[index + 1];
    if (first !== undefined && second !== undefined)
      result.push([first, second]);
  }
  return result;
}
