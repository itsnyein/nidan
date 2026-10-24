import { Node, SyntaxKind, type SourceFile } from "ts-morph";

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
          explanation: explain(
            seed.key,
            pos,
            filePath,
            sourceFile,
            callable,
            input,
          ),
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
  seedKey: string,
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
  const heritage = heritageVerdict(seedKey, pos, filePath, sourceFile, input);
  if (heritage !== undefined) return heritage;

  if (input.result.usages.some(at(seedKey, filePath, pos)))
    return { kind: "usage" };

  const node = sourceFile.getDescendantAtPos(pos);

  const filtered = input.result.filtered.find(at(seedKey, filePath, pos));
  if (filtered !== undefined && believableHere(filtered.reason, node)) {
    return { kind: "filtered", reason: filtered.reason };
  }

  // Positions inside trivia have no descendant: an occurrence of the characters only.
  if (node === undefined) return { kind: "comment-or-string" };

  // Ahead of the literal rule below, and for the same reason the heritage tripwire is
  // ahead of `filtered`. A literal that keys an element access **is** a reference, so
  // answering `comment-or-string` for it would absorb a lost usage: the occurrence would
  // still look accounted for while nothing reported the call.
  //
  // Both literal spellings, matching §15b. A template literal with substitutions is a
  // different node kind and is excluded here by construction.
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    const key = elementAccessKeyVerdict(
      seedKey,
      node,
      filePath,
      callable,
      input,
    );
    if (key !== undefined) return key;
  }

  // A literal's text is not an identifier: an occurrence of the characters, not of the
  // symbol.
  if (!Node.isIdentifier(node)) return { kind: "comment-or-string" };

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
 * The `obj["method"]()` tripwire, or `undefined` when the literal is ordinary text.
 *
 * The occurrence scan works on source text, so it finds the seed's name **inside** the
 * quotes, one character past where the reference node starts. The usage records the node,
 * so the two positions never match and the plain lookup misses — which is why this
 * compares by the literal's own start rather than by the occurrence position.
 *
 * Returning `undefined` means "not an element-access key": an ordinary string or template
 * literal that merely contains the name, which the caller is right to treat as text.
 */
function elementAccessKeyVerdict(
  seedKey: string,
  literal: Node,
  filePath: string,
  callable: Callable,
  input: DifferentialInput,
): Explanation | undefined {
  const parent = literal.getParent();
  if (
    parent === undefined ||
    !Node.isElementAccessExpression(parent) ||
    parent.getArgumentExpression() !== literal
  ) {
    return undefined;
  }

  // Resolved from the **literal**, which is where the compiler puts the member symbol
  // for a literal key. The enclosing element access has no symbol of its own, so
  // resolving from it finds nothing and every key reads as ordinary text.
  const declarations = resolvedDeclarationsOf(literal);
  if (
    !declarations.some((declaration) =>
      isInsideTarget(declaration, callable, input.repoRoot),
    )
  ) {
    // A key that addresses some other member. Not this seed, and not text either.
    return declarations.length === 0 ? undefined : { kind: "different-symbol" };
  }

  const start = literal.getStart();
  if (input.result.usages.some(at(seedKey, filePath, start)))
    return { kind: "usage" };

  const filtered = input.result.filtered.find(at(seedKey, filePath, start));
  if (filtered !== undefined) {
    return { kind: "filtered", reason: filtered.reason };
  }

  return {
    kind: "unexplained",
    why: "a string-literal element access that resolves to the seed, which discovery neither reported nor filtered",
  };
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
  seedKey: string,
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
  // `extends`, not `implements`. Without this a class implementing a seed class was run
  // through the construction tripwire, and an implementing class with no constructor of
  // its own was reported unexplained for "no implicit construct usage" — a false alarm
  // about code that constructs nothing. `implements` is a type position and is settled
  // by the filter rules, not here.
  if (clause.getToken() !== SyntaxKind.ExtendsKeyword) return undefined;
  const subclass = clause.getParent();
  if (!Node.isClassDeclaration(subclass) && !Node.isClassExpression(subclass)) {
    return undefined;
  }

  if (input.result.usages.some(at(seedKey, filePath, pos)))
    return { kind: "usage" };

  const constructor = subclass
    .getConstructors()
    .find((candidate) => candidate.getBody() !== undefined);
  if (constructor === undefined) {
    return {
      kind: "unexplained",
      why: "a subclass with no constructor, and no implicit construct usage reported for its extends clause",
    };
  }

  // Scoped to **this seed**, like every other lookup here. A `super()` site carries no
  // textual occurrence of the class name, so this searches a byte range rather than a
  // position — which makes the seed key load-bearing rather than incidental: without it
  // any other changed callable invoked in the same constructor explains away the loss of
  // the `super()` this clause delegates to.
  const reported = input.result.usages.some(
    (usage) =>
      usage.seedKey === seedKey &&
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

/**
 * Whether a filter reason can be true of the place the occurrence actually sits.
 *
 * The harness used to accept any filtered record at the position, which is how a
 * supported-pattern usage disappeared with the check agreeing: everything under
 * `extends withRetry(Client)` was filtered `type-only`, and "it was filtered" was taken
 * as an explanation without asking whether that reason could hold there.
 *
 * Only `type-only` is judged, because it is the only reason whose truth depends on
 * *where* the node is rather than on what the node is. Resolved independently of the
 * analyzer, per §10 — a check that shared the classifier's walk would have agreed with
 * the bug, which is precisely what happened.
 */
function believableHere(reason: string, node: Node | undefined): boolean {
  if (reason !== "type-only") return true;
  return node !== undefined && sitsInTypePosition(node);
}

/** A type position, deciding a class's `extends` expression to be a value position. */
function sitsInTypePosition(node: Node): boolean {
  for (
    let current: Node | undefined = node;
    current !== undefined;
    current = current.getParent()
  ) {
    if (Node.isExpressionWithTypeArguments(current)) {
      const clause = current.getParent();
      if (Node.isHeritageClause(clause)) {
        const owner = clause.getParent();
        // An interface's `extends` and a class's `implements` are type positions. A
        // class's `extends` evaluates an expression at runtime and is not.
        const classExtends =
          clause.getToken() === SyntaxKind.ExtendsKeyword &&
          (Node.isClassDeclaration(owner) || Node.isClassExpression(owner));
        return !classExtends;
      }
    }
    if (Node.isTypeNode(current)) return true;
    if (Node.isStatement(current)) return false;
  }
  return false;
}

/**
 * A record belonging to **this seed**, at this position.
 *
 * The seed key is not decoration. Base and head share relative paths, so without it a
 * base-side occurrence can be explained by a head-side usage that happens to sit at the
 * same offset — which is the ordinary **rename** shape, where the old and new call sites
 * land at the same offset in the same file. The check would then report "nothing
 * unexplained" while the deleted seed's usage was gone.
 */
function at(seedKey: string, filePath: string, pos: number) {
  return (site: {
    readonly seedKey: string;
    readonly filePath: string;
    readonly pos: number;
  }): boolean =>
    site.seedKey === seedKey && site.filePath === filePath && site.pos === pos;
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
