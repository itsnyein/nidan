import { Node, type SourceFile } from "ts-morph";

import type { Callable } from "../../src/analysis/identity.js";
import type {
  ReferenceResult,
  SnapshotReferences,
} from "../../src/analysis/references.js";
import type { Seed, SeedGap } from "../../src/analysis/seeds.js";

/**
 * How a textual occurrence of a seed's name was accounted for.
 *
 * `unexplained` is the only outcome that fails. It is reachable: the resolution below is
 * done from the source text and the compiler, not from what discovery reported, so a
 * reference that discovery missed lands here rather than being absorbed.
 */
export type Explanation =
  | { readonly kind: "usage" }
  | { readonly kind: "filtered"; readonly reason: string }
  | { readonly kind: "undecided"; readonly reason: string }
  | { readonly kind: "comment-or-string" }
  | { readonly kind: "different-symbol" }
  | { readonly kind: "gap" }
  | { readonly kind: "unexplained"; readonly why: string };

export interface Occurrence {
  readonly seedKey: string;
  readonly filePath: string;
  readonly line: number;
  readonly pos: number;
  readonly explanation: Explanation;
}

export interface DifferentialInput {
  readonly result: ReferenceResult;
  readonly seeds: readonly Seed[];
  readonly gaps: readonly SeedGap[];
  readonly base: SnapshotReferences;
  readonly head: SnapshotReferences;
  readonly repoRoot: string;
}

/**
 * Every text occurrence of every seed's name, with how it was accounted for (spec §13).
 *
 * Derived from the **source text**, independently of discovery's output. A harness that
 * enumerated what discovery found could only ever confirm it; the question worth asking
 * is what the text contains that discovery did not report.
 */
export function explainOccurrences(input: DifferentialInput): Occurrence[] {
  const occurrences: Occurrence[] = [];

  for (const seed of input.seeds) {
    const snapshot = seed.snapshot === "base" ? input.base : input.head;
    const callable = snapshot.index.callables.find(
      (entry) => entry.key === seed.key,
    );
    if (callable === undefined) continue;

    const name = searchNameOf(callable);
    if (name === undefined) continue;

    for (const sourceFile of analyzedFiles(snapshot, input.repoRoot)) {
      const filePath = relativePathOf(sourceFile, input.repoRoot);
      for (const pos of occurrencesOf(sourceFile.getFullText(), name)) {
        occurrences.push({
          seedKey: seed.key,
          filePath,
          line: sourceFile.getLineAndColumnAtPos(pos).line,
          pos,
          explanation: explain(pos, filePath, sourceFile, callable, input),
        });
      }
    }
  }

  return occurrences;
}

/** The occurrences that nothing accounted for. Empty is the only acceptable result. */
export function unexplainedOf(
  occurrences: readonly Occurrence[],
): Occurrence[] {
  return occurrences.filter(
    (occurrence) => occurrence.explanation.kind === "unexplained",
  );
}

/**
 * The name a seed is searched under.
 *
 * A constructor is searched under its **class** name: `constructor` as a word appears in
 * every class that has one, and in none of the places the seed is actually used.
 */
function searchNameOf(callable: Callable): string | undefined {
  if (callable.kind !== "constructor") return callable.name;
  return callable.containerChain.at(-1);
}

function analyzedFiles(
  snapshot: SnapshotReferences,
  repoRoot: string,
): SourceFile[] {
  return snapshot.sourceFiles.filter((sourceFile) => {
    if (sourceFile.isDeclarationFile()) return false;
    const path = relativePathOf(sourceFile, repoRoot);
    return !path.startsWith("/") && !path.split("/").includes("node_modules");
  });
}

function relativePathOf(sourceFile: SourceFile, repoRoot: string): string {
  const absolute = sourceFile.getFilePath().replace(/\\/gu, "/");
  const root = repoRoot.replace(/\\/gu, "/");
  return absolute.startsWith(`${root}/`)
    ? absolute.slice(root.length + 1)
    : absolute;
}

/**
 * Whole-word occurrences of `name` in `text`.
 *
 * Boundaries are tested against the JavaScript identifier alphabet rather than with `\b`,
 * because `$` and `_` are identifier characters that `\b` treats as boundaries — so
 * `formatRow_v2` would match a search for `formatRow` and arrive here as an occurrence
 * that nothing can explain.
 */
function occurrencesOf(text: string, name: string): number[] {
  const found: number[] = [];
  let index = text.indexOf(name);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + name.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after))
      found.push(index);
    index = text.indexOf(name, index + 1);
  }
  return found;
}

function isIdentifierChar(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}$]/u.test(character);
}

function explain(
  pos: number,
  filePath: string,
  sourceFile: SourceFile,
  callable: Callable,
  input: DifferentialInput,
): Explanation {
  if (input.result.usages.some(at(filePath, pos))) return { kind: "usage" };

  const filtered = input.result.filtered.find(at(filePath, pos));
  if (filtered !== undefined) {
    return { kind: "filtered", reason: filtered.reason };
  }

  const undecided = input.result.undecided.find(at(filePath, pos));
  if (undecided !== undefined) {
    return { kind: "undecided", reason: undecided.reason };
  }

  const node = sourceFile.getDescendantAtPos(pos);
  // Positions inside trivia have no descendant, and a literal's text is not an
  // identifier: both are occurrences of the characters, not of the symbol.
  if (node === undefined || !Node.isIdentifier(node)) {
    return { kind: "comment-or-string" };
  }

  const declarations = resolvedDeclarationsOf(node);
  if (declarations.length === 0) {
    return coveredByGap(
      filePath,
      sourceFile.getLineAndColumnAtPos(pos).line,
      input,
    )
      ? { kind: "gap" }
      : {
          kind: "unexplained",
          why: "an identifier that resolves to nothing and no gap reports it",
        };
  }

  // The weight-bearing branch. An identifier that resolves **into the seed's own
  // declaration** is a reference to the seed; reaching here means discovery neither
  // reported nor filtered it, which is the silent miss this harness exists to catch.
  if (
    declarations.some((declaration) => isInsideCallable(declaration, callable))
  ) {
    return {
      kind: "unexplained",
      why: "resolves to the seed but discovery neither reported nor filtered it",
    };
  }

  return { kind: "different-symbol" };
}

/**
 * Every declaration the identifier can reach, with import and export aliases followed.
 *
 * Without the alias chain this returns the **import specifier** for an ordinary
 * cross-module call, which lives in the calling file and so is never inside the seed —
 * every missed usage would then be explained as a different symbol, and the harness would
 * agree with any implementation at all. Its own mutation test caught exactly that.
 */
function resolvedDeclarationsOf(node: Node): Node[] {
  let symbol = node.getSymbol();
  const seen = new Set<unknown>();
  const declarations: Node[] = [];

  while (symbol !== undefined && !seen.has(symbol)) {
    seen.add(symbol);
    declarations.push(...symbol.getDeclarations());
    symbol = symbol.getAliasedSymbol();
  }

  return declarations;
}

function at(filePath: string, pos: number) {
  return (site: { readonly filePath: string; readonly pos: number }): boolean =>
    site.filePath === filePath && site.pos === pos;
}

function isInsideCallable(declaration: Node, callable: Callable): boolean {
  const path = declaration.getSourceFile().getFilePath().replace(/\\/gu, "/");
  if (!path.endsWith(`/${callable.filePath}`)) return false;
  const start = declaration.getStart();
  return callable.ranges.some(
    (range) => start >= range.startPos && start < range.endPos,
  );
}

function coveredByGap(
  filePath: string,
  line: number,
  input: DifferentialInput,
): boolean {
  return input.gaps.some((gap) => {
    if (gap.filePath !== filePath) return false;
    return gap.kind === "unmapped-change"
      ? gap.line === line
      : gap.lines.includes(line);
  });
}
