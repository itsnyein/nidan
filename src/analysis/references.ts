import {
  Node,
  SyntaxKind,
  type ReferencedSymbol,
  type SourceFile,
} from "ts-morph";

import {
  constructorKeyFor,
  type Callable,
  type CallableIndex,
} from "./identity.js";
import type { Seed, Snapshot } from "./seeds.js";

/**
 * Why a reference is not a usage.
 *
 * Each reason is reported, never collapsed into a bare "filtered". The differential
 * harness asserts the reason, so a filter that starts swallowing the wrong references
 * fails a test that names it — the mistake the formatting bucket made during seed
 * mapping, where an unexamined catch-all absorbed real changes while the count balanced.
 */
export type FilterReason =
  | "declaration"
  | "import-specifier"
  | "export-specifier"
  | "type-only"
  | "heritage-clause";

/**
 * What the reference does with the seed (§6.2).
 *
 * `value-reference` is the residue: a reference that survives the filters and is neither
 * a call, a construction, nor a JSX tag. The relation label is settled here; the separate
 * `valueReferences` projection and the wrapper/CommonJS pattern list are later work.
 */
export type Relation =
  "invoke" | "construct" | "jsx-render" | "value-reference";

export interface UsageResolution {
  readonly status: "exact" | "ambiguous";
  readonly candidates?: readonly string[];
}

export interface ReferenceSite {
  readonly filePath: string;
  readonly line: number;
  /** Character offset in the file, used by the differential harness to match occurrences. */
  readonly pos: number;
}

export interface Usage extends ReferenceSite {
  readonly seedKey: string;
  readonly relation: Relation;
  /** The enclosing supported callable's key, or `<path> :: module` for top-level code. */
  readonly from: string;
  readonly resolution: UsageResolution;
  /**
   * Set when the construction has no call expression to point at — a subclass with no
   * explicit constructor, whose `extends` clause *is* the construction. The site is a
   * declaration, so a reader following it lands on `extends Base` rather than on
   * something that looks like a call.
   */
  readonly implicit?: true;
}

export interface FilteredReference extends ReferenceSite {
  readonly seedKey: string;
  readonly reason: FilterReason;
}

export interface ReferenceResult {
  readonly usages: readonly Usage[];
  readonly filtered: readonly FilteredReference[];
}

export interface SnapshotReferences {
  readonly sourceFiles: readonly SourceFile[];
  readonly index: CallableIndex;
}

export interface FindUsagesInput {
  readonly seeds: readonly Seed[];
  readonly base: SnapshotReferences;
  readonly head: SnapshotReferences;
  readonly repoRoot: string;
}

/**
 * Finds the usages of every seed, with the references that were filtered and why.
 *
 * References are searched in the **usage-source snapshot**: head for an added or modified
 * seed, base for a deleted one, because a deleted callable's callers only exist in base.
 */
export function findUsages(input: FindUsagesInput): ReferenceResult {
  const usages: Usage[] = [];
  const filtered: FilteredReference[] = [];

  for (const seed of input.seeds) {
    const snapshot = snapshotFor(seed.snapshot, input);
    const callable = snapshot.index.callables.find(
      (entry) => entry.key === seed.key,
    );
    // A seed whose key is not in the index cannot be searched for. That is not silence:
    // seed mapping only emits keys it took from this same index, so this is unreachable
    // rather than a case to degrade into.
    if (callable === undefined) continue;

    collectForSeed(seed, callable, snapshot, input.repoRoot, {
      usages,
      filtered,
    });
  }

  return {
    usages: usages.sort(compareSites),
    filtered: filtered.sort(compareSites),
  };
}

interface Buckets {
  readonly usages: Usage[];
  readonly filtered: FilteredReference[];
}

function snapshotFor(
  snapshot: Snapshot,
  input: FindUsagesInput,
): SnapshotReferences {
  return snapshot === "base" ? input.base : input.head;
}

function collectForSeed(
  seed: Seed,
  callable: Callable,
  snapshot: SnapshotReferences,
  repoRoot: string,
  buckets: Buckets,
): void {
  const searchNode = searchNodeFor(callable);
  if (searchNode === undefined) return;

  const target = targetSpansOf(callable, searchNode);

  for (const group of searchNode.findReferences()) {
    const resolution = resolutionOf(group, target, repoRoot);
    for (const entry of group.getReferences()) {
      const node = entry.getNode();
      const site = siteOf(node, repoRoot);
      const reason = filterReasonFor(node, entry.isDefinition() === true);

      if (reason === "heritage-clause") {
        classifyHeritageClause(
          node,
          seed,
          site,
          snapshot,
          repoRoot,
          resolution,
          buckets,
        );
        continue;
      }
      if (reason !== undefined) {
        buckets.filtered.push({ seedKey: seed.key, reason, ...site });
        continue;
      }

      buckets.usages.push({
        seedKey: seed.key,
        relation: relationOf(node),
        from: fromOf(node, snapshot, site.filePath),
        resolution,
        ...site,
      });
    }
  }
}

/**
 * The node whose references answer for this seed.
 *
 * A constructor is searched through its **class** name (§7.3): `new C()` and `super()`
 * are references to the class, and a constructor's own name node does not exist.
 */
function searchNodeFor(callable: Callable): ReferenceSearchNode | undefined {
  const declaration = callable.declaration;
  if (callable.kind === "constructor") {
    const classDeclaration = declaration.getFirstAncestor(
      (ancestor) =>
        Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor),
    );
    return classDeclaration === undefined
      ? undefined
      : nameNodeOf(classDeclaration);
  }
  return nameNodeOf(declaration);
}

type ReferenceSearchNode = Node & { findReferences(): ReferencedSymbol[] };

function nameNodeOf(node: Node): ReferenceSearchNode | undefined {
  if (!Node.hasName(node)) return undefined;
  const nameNode = node.getNameNode();
  // An anonymous default export has no name node to search from; its references are
  // reached through the export assignment, which the value-reference projection covers.
  return Node.isReferenceFindable(nameNode) ? nameNode : undefined;
}

/** The filter rules of §9, in the order a reference can match them. */
function filterReasonFor(
  node: Node,
  isDefinition: boolean,
): FilterReason | undefined {
  if (isDefinition) return "declaration";

  const parent = node.getParent();
  if (parent === undefined) return "declaration";

  if (
    Node.isImportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent)
  ) {
    return "import-specifier";
  }
  // `export default foo` is an ExportAssignment, not an ExportSpecifier. Missing it
  // reported the alias as a call site, against the approved `identity-default-exports`
  // record, which freezes no usages for it: §7.2 calls the default export an alias, and
  // using a callable as a value belongs to `valueReferences`, not here.
  // Shadowed by the declaration rule below for *filtering* — an export specifier is one
  // of its own symbol's declarations — and kept because it supplies the reported reason.
  // Do not remove it: the differential harness asserts the reason, not merely that the
  // reference was filtered.
  if (Node.isExportSpecifier(parent) || Node.isExportAssignment(parent)) {
    return "export-specifier";
  }

  // A related symbol's own declaration — an interface member the seed implements, or a
  // base method it overrides — is a declaration site, and `isDefinition` is false for it
  // because it is not the definition of the *searched* symbol. Without this it is
  // reported as a usage of the seed, which is a usage of nothing: the line declares the
  // method, it does not call it.
  if (isDeclarationNameNode(node, parent)) return "declaration";
  if (isHeritageReference(parent)) return "heritage-clause";
  if (isTypeOnlyPosition(node)) return "type-only";

  return undefined;
}

/**
 * Whether the reference is the name of a declaration rather than a use of one.
 *
 * Tested by asking whether the parent is itself one of its symbol's declarations, not by
 * listing node kinds. `g.greet()` also has a name node — a kind list that forgot to
 * exclude property access filtered every member call as a declaration, which is how this
 * was first written and how the interface probe caught it.
 */
function isDeclarationNameNode(node: Node, parent: Node): boolean {
  if (!Node.hasName(parent) || parent.getNameNode() !== node) return false;
  return (
    parent
      .getSymbol()
      ?.getDeclarations()
      .some((declaration) => declaration === parent) === true
  );
}

/**
 * A class's `extends` clause, and nothing else.
 *
 * `implements` is a type position that §9 already settles, and an interface's `extends`
 * is one too. Matching any heritage clause sent both down the construct path, which
 * answers a question neither of them asks: neither constructs anything.
 */
function isHeritageReference(parent: Node): boolean {
  if (!Node.isExpressionWithTypeArguments(parent)) return false;
  const clause = parent.getParent();
  if (!Node.isHeritageClause(clause)) return false;
  if (clause.getToken() !== SyntaxKind.ExtendsKeyword) return false;
  const owner = clause.getParent();
  return Node.isClassDeclaration(owner) || Node.isClassExpression(owner);
}

/**
 * Whether the reference sits in a type position rather than a value one.
 *
 * Walks ancestors rather than testing the immediate parent: `Promise<Client>` and
 * `(x: Client) => void` both put the reference several nodes below the type node, and a
 * parent-only test would report an annotation as a usage.
 */
function isTypeOnlyPosition(node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (Node.isTypeNode(current)) return true;
    // A heritage clause contains a type node in `implements`, but `extends` on a class is
    // a value position; stopping here keeps the heritage rule the one that decides.
    if (Node.isHeritageClause(current)) return false;
    if (Node.isStatement(current)) return false;
    current = current.getParent();
  }
  return false;
}

/**
 * The two halves of the heritage rule, which are exclusive, so a construction is reported
 * exactly once either way.
 *
 * **With an explicit constructor** the clause is a filtered non-usage and that
 * constructor's `super()` call carries the construction; counting both would report one
 * construction twice.
 *
 * **Without one** there is no `super()` anywhere in the source, so the clause *is* the
 * construction: filtering it would leave the construction reported by nothing at all.
 * `from` names the constructor the class would have — it has none to point at, and naming
 * the class instead would make this usage's `from` a different kind of thing from every
 * other usage's.
 */
function classifyHeritageClause(
  node: Node,
  seed: Seed,
  site: ReferenceSite,
  snapshot: SnapshotReferences,
  repoRoot: string,
  resolution: UsageResolution,
  buckets: Buckets,
): void {
  const subclass = node.getFirstAncestor(
    (ancestor) =>
      Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor),
  );
  const constructor =
    subclass !== undefined &&
    (Node.isClassDeclaration(subclass) || Node.isClassExpression(subclass))
      ? // The implementation, not an overload signature: an overloaded constructor set
        // puts the signatures first, and a signature has no body to scan, so the
        // heritage clause would be filtered while the `super()` was never found.
        (subclass
          .getConstructors()
          .find((candidate) => candidate.getBody() !== undefined) ??
        subclass.getConstructors()[0])
      : undefined;

  if (constructor === undefined) {
    const from =
      subclass === undefined
        ? `${site.filePath} :: module`
        : (constructorKeyFor(subclass, site.filePath) ??
          `${site.filePath} :: module`);
    buckets.usages.push({
      seedKey: seed.key,
      relation: "construct",
      from,
      resolution,
      implicit: true,
      ...site,
    });
    return;
  }

  buckets.filtered.push({
    seedKey: seed.key,
    reason: "heritage-clause",
    ...site,
  });

  // `super` is not a reference to the class by name, so the compiler's reference search
  // never returns it. The heritage clause is the only thing connecting the two classes,
  // which is why the construction is collected here rather than from the search results.
  for (const call of constructor.getDescendants()) {
    if (!Node.isCallExpression(call)) continue;
    if (!Node.isSuperExpression(call.getExpression())) continue;
    // `super` inside a class declared within this constructor belongs to that class, not
    // to this one. Attributing it here would name the wrong parent.
    if (ownerConstructorOf(call) !== constructor) continue;
    const superSite = siteOf(call.getExpression(), repoRoot);
    buckets.usages.push({
      seedKey: seed.key,
      relation: "construct",
      from: fromOf(call, snapshot, superSite.filePath),
      resolution,
      ...superSite,
    });
  }
}

/** The constructor a `super()` call belongs to, stopping at the first class boundary. */
function ownerConstructorOf(call: Node): Node | undefined {
  return call.getFirstAncestor(
    (ancestor) =>
      Node.isConstructorDeclaration(ancestor) ||
      Node.isClassDeclaration(ancestor) ||
      Node.isClassExpression(ancestor),
  );
}

/**
 * What the reference does with the seed (§6.2).
 *
 * Decided from the reference node's position, not from the symbol: the same symbol is
 * invoked in one place, passed as a value in another, and rendered in a third.
 */
function relationOf(node: Node): Relation {
  const target = outermostAccess(node);
  const parent = target.getParent();
  if (parent === undefined) return "value-reference";

  // `getExpression() === target` matters: in `fn(other)` the identifier `other` is an
  // *argument* of a call, not its callee, and testing only "is inside a call" would
  // report every argument as an invocation.
  if (Node.isCallExpression(parent) && parent.getExpression() === target) {
    return "invoke";
  }
  if (Node.isNewExpression(parent) && parent.getExpression() === target) {
    return "construct";
  }
  if (Node.isJsxTagNamed(parent) && parent.getTagNameNode() === target) {
    return "jsx-render";
  }

  return "value-reference";
}

/**
 * The outermost member access the reference is the name of.
 *
 * `obj.method()` reaches here as the identifier `method`, whose parent is the property
 * access rather than the call; without this step every member call would classify as a
 * value reference. `<UI.Card />` is the same shape with a JSX tag.
 *
 * `obj["method"]()` is the same access written differently (§15b): the reference arrives
 * as the **string literal** key, and the compiler resolves it to the same member, so it
 * walks the same way and classifies the same. A non-literal key addresses no particular
 * member, the compiler never returns it as a reference, and so nothing reaches here.
 */
function outermostAccess(node: Node): Node {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return current;
    // `<UI.Card />` parses its tag as a JSX member expression, which ts-morph exposes as
    // a property access; one test covers both spellings.
    const isNamedPart =
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === current;
    // Only a string literal. A computed key that is anything else does not name a member
    // at compile time, so treating it as one would invent an access the compiler never
    // resolved.
    const isLiteralKey =
      Node.isElementAccessExpression(parent) &&
      parent.getArgumentExpression() === current &&
      Node.isStringLiteral(current);
    if (!isNamedPart && !isLiteralKey) return current;
    current = parent;
  }
}

/** The enclosing supported callable, or the module node (§9). */
function fromOf(
  node: Node,
  snapshot: SnapshotReferences,
  filePath: string,
): string {
  const pos = node.getStart();
  let innermost: Callable | undefined;

  for (const callable of snapshot.index.callables) {
    if (callable.filePath !== filePath) continue;
    if (!containsPos(callable, pos)) continue;
    if (innermost === undefined || isInsideOf(callable, innermost)) {
      innermost = callable;
    }
  }

  return innermost?.key ?? `${filePath} :: module`;
}

function containsPos(callable: Callable, pos: number): boolean {
  return callable.ranges.some(
    (range) => pos >= range.startPos && pos < range.endPos,
  );
}

/** Whether `inner`'s span lies within `outer`'s, so the innermost owner can be chosen. */
function isInsideOf(inner: Callable, outer: Callable): boolean {
  return inner.startPos >= outer.startPos && inner.endPos <= outer.endPos;
}

/** A span in one file, used to decide whether a resolved declaration is the seed. */
interface TargetSpans {
  readonly filePath: string;
  readonly spans: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
}

/**
 * The declarations a reference must resolve to for this seed.
 *
 * For an overload set this is every member declaration, not just the implementation: a
 * caller resolves to whichever signature matched, and all of them are the same callable.
 * For a constructor it is the class, since that is what the search ran on.
 */
function targetSpansOf(
  callable: Callable,
  searchNode: ReferenceSearchNode,
): TargetSpans {
  if (callable.kind === "constructor") {
    const classDeclaration = searchNode.getParent();
    return {
      filePath: callable.filePath,
      spans:
        classDeclaration === undefined
          ? []
          : [
              {
                start: classDeclaration.getStart(),
                end: classDeclaration.getEnd(),
              },
            ],
    };
  }
  return {
    filePath: callable.filePath,
    spans: callable.ranges.map((range) => ({
      start: range.startPos,
      end: range.endPos,
    })),
  };
}

/**
 * `exact` when the group's definition resolves to the seed, `ambiguous` when it does not.
 *
 * Group *count* is not the question. The compiler returns one group per referenced
 * symbol, and an ordinary re-export produces a second group for the alias — so counting
 * groups would call every barrel ambiguous, which the approved barrel fixtures say it is
 * not. What matters is where the group's definition lands after alias resolution.
 */
function resolutionOf(
  group: ReferencedSymbol,
  target: TargetSpans,
  repoRoot: string,
): UsageResolution {
  const declarations = resolvedDeclarationsOf(group);
  if (declarations.some((node) => isWithinTarget(node, target, repoRoot))) {
    return { status: "exact" };
  }

  // Repository-relative and deduplicated: an absolute path would make the report depend
  // on where the repository sits on disk, and the alias walk visits the same declaration
  // from more than one symbol.
  const candidates = [
    ...new Set(
      declarations.map(
        (node) =>
          `${siteOf(node, repoRoot).filePath}:${String(node.getStartLineNumber())}`,
      ),
    ),
  ].sort();

  return { status: "ambiguous", candidates };
}

/** The group definition's declarations, with import/export aliases followed to the end. */
function resolvedDeclarationsOf(group: ReferencedSymbol): Node[] {
  const definition = group.getDefinition().getDeclarationNode();
  if (definition === undefined) return [];

  let symbol = definition.getSymbol();
  const seen = new Set<unknown>();
  const declarations: Node[] = [definition];

  while (symbol !== undefined && !seen.has(symbol)) {
    seen.add(symbol);
    declarations.push(...symbol.getDeclarations());
    symbol = symbol.getAliasedSymbol();
  }

  return declarations;
}

function isWithinTarget(
  node: Node,
  target: TargetSpans,
  repoRoot: string,
): boolean {
  // The repository-relative path, not a suffix match: a snapshot holding both
  // `src/greet.ts` and `vendor/src/greet.ts` satisfies a suffix test for either, leaving
  // only the span check between that and a wrong `exact`.
  if (siteOf(node, repoRoot).filePath !== target.filePath) return false;
  const start = node.getStart();
  return target.spans.some((span) => start >= span.start && start < span.end);
}

function siteOf(node: Node, repoRoot: string): ReferenceSite {
  const absolute = node.getSourceFile().getFilePath().replace(/\\/gu, "/");
  const root = repoRoot.replace(/\\/gu, "/");
  const filePath = absolute.startsWith(`${root}/`)
    ? absolute.slice(root.length + 1)
    : absolute;
  return {
    filePath,
    line: node.getStartLineNumber(),
    pos: node.getStart(),
  };
}

/** Deterministic order: file, then line, then position, then seed. */
function compareSites<T extends ReferenceSite & { readonly seedKey: string }>(
  left: T,
  right: T,
): number {
  if (left.filePath !== right.filePath)
    return left.filePath < right.filePath ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.pos !== right.pos) return left.pos - right.pos;
  if (left.seedKey === right.seedKey) return 0;
  return left.seedKey < right.seedKey ? -1 : 1;
}
