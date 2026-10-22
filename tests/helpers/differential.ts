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
  // **First**, ahead of the usage and filtered lookups. An `extends` clause is filtered
  // in the explicit-constructor case, and accepting "filtered" as its explanation is the
  // whole hole: that the clause was filtered says nothing about whether the `super()` it
  // delegates to was found.
  const heritage = heritageVerdict(pos, filePath, sourceFile, input);
  if (heritage !== undefined) return heritage;

  if (input.result.usages.some(at(filePath, pos))) return { kind: "usage" };

  const filtered = input.result.filtered.find(at(filePath, pos));
  if (filtered !== undefined) {
    return { kind: "filtered", reason: filtered.reason };
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
    declarations.some((declaration) =>
      isInsideTarget(declaration, callable, input.repoRoot),
    )
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

/**
 * The `extends <SeedName>` tripwire.
 *
 * A `super()` site contains no textual occurrence of the class name, so losing `super()`
 * detection was invisible to a harness that only explains occurrences. The `extends`
 * clause *does* carry the name, and exactly two things may explain it: the implicit
 * construct usage reported at the clause itself, or a `super()` usage inside that
 * subclass's explicit constructor. Neither means the construction is reported by nothing,
 * which is the outcome this harness exists to make impossible.
 *
 * Deliberately ahead of the `filtered` lookup. In the explicit-constructor case the clause
 * **is** filtered, and accepting that as an explanation is precisely the hole: that the
 * clause was filtered says nothing about whether the `super()` it delegates to was found.
 */
function heritageVerdict(
  pos: number,
  filePath: string,
  sourceFile: SourceFile,
  input: DifferentialInput,
): Explanation | undefined {
  const node = sourceFile.getDescendantAtPos(pos);
  if (node === undefined) return undefined;
  const parent = node.getParent();
  if (parent === undefined || !Node.isExpressionWithTypeArguments(parent)) {
    return undefined;
  }
  const clause = parent.getParent();
  if (!Node.isHeritageClause(clause)) return undefined;
  const subclass = clause.getParent();
  if (!Node.isClassDeclaration(subclass) && !Node.isClassExpression(subclass)) {
    return undefined;
  }

  if (input.result.usages.some(at(filePath, pos))) return { kind: "usage" };

  const constructor = subclass
    .getConstructors()
    .find((candidate) => candidate.getBody() !== undefined);
  if (constructor === undefined) {
    return {
      kind: "unexplained",
      why: "a subclass with no constructor, and no implicit construct usage reported for its extends clause",
    };
  }

  const reported = input.result.usages.some(
    (usage) =>
      usage.filePath === filePath &&
      usage.pos >= constructor.getStart() &&
      usage.pos < constructor.getEnd(),
  );
  return reported
    ? { kind: "usage" }
    : {
        kind: "unexplained",
        why: "an extends clause whose subclass constructor reported no super() usage",
      };
}

function at(filePath: string, pos: number) {
  return (site: { readonly filePath: string; readonly pos: number }): boolean =>
    site.filePath === filePath && site.pos === pos;
}

/**
 * Whether a resolved declaration is the thing the occurrence was searched under.
 *
 * For a constructor that is the **class**, not the constructor's own range. The
 * occurrences are of the class name, and `new Client()` resolves to the class
 * declaration — which lies outside the constructor — so testing the constructor's range
 * put every constructor reference into `different-symbol`. A dropped `new` usage was then
 * explained away, and "zero unexplained" held vacuously for both constructor fixtures:
 * the same hollowness this harness was built to detect, surviving in the one shape its
 * mutation test did not cover.
 */
function isInsideTarget(
  declaration: Node,
  callable: Callable,
  repoRoot: string,
): boolean {
  const path = relativePathOf(declaration.getSourceFile(), repoRoot);
  if (path !== callable.filePath) return false;

  const start = declaration.getStart();
  const spans =
    callable.kind === "constructor"
      ? classSpansOf(callable)
      : callable.ranges.map((range) => ({
          start: range.startPos,
          end: range.endPos,
        }));

  return spans.some((span) => start >= span.start && start < span.end);
}

function classSpansOf(
  callable: Callable,
): Array<{ start: number; end: number }> {
  const owner = callable.declaration.getFirstAncestor(
    (ancestor) =>
      Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor),
  );
  return owner === undefined
    ? []
    : [{ start: owner.getStart(), end: owner.getEnd() }];
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
