import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type ConstructorDeclaration,
  type ExportAssignment,
  type FunctionDeclaration,
  type MethodDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

import { isWithin, toPosixPath } from "../project/paths.js";

/**
 * The closed set of declaration kinds, per specification §7.2 as amended.
 *
 * `function` spans several syntactic forms deliberately — a function declaration, a
 * variable holding an arrow or function expression, and a default export are all free
 * standing callables. Keying them by their syntax would make rewriting one form as
 * another read as a deletion plus an addition.
 */
export type DeclarationKind = "function" | "method" | "constructor";

/** The name an anonymous default export is keyed by. */
const ANONYMOUS_DEFAULT_NAME = "default";

/** Directory whose contents are dependencies, never repository source. */
const NODE_MODULES_SEGMENT = "node_modules";

/** Separates container names within the chain, for a callable nested more than once. */
const CONTAINER_SEPARATOR = ".";

/** One declaration's own extent, 1-based lines and character offsets. */
export interface DeclarationRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startPos: number;
  readonly endPos: number;
}

export interface Callable {
  /** `relativePosixPath :: containerChain :: declarationKind :: name [:: static]` */
  readonly key: string;
  /**
   * The declaration this callable was built from — the implementation signature for an
   * overload set.
   *
   * Reference discovery needs a node to ask the compiler about, and recovering one from
   * `startPos` would mean a second, parallel idea of which node a key denotes. Two such
   * ideas drift: the one here is the one the key was computed from, by construction.
   */
  readonly declaration: Node;
  /** Repository-relative POSIX path. */
  readonly filePath: string;
  /** Enclosing classes and callables, outermost first. */
  readonly containerChain: readonly string[];
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly isStatic: boolean;
  /**
   * 1-based inclusive line span covering the whole declaration: leading JSDoc,
   * decorators, signature, and body. This is the extent a diff hunk is tested against.
   */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Character offsets of the same span. Lines cannot express nesting when an outer and
   * an inner callable share one line; positions always can.
   */
  readonly startPos: number;
  readonly endPos: number;
  /**
   * The extent of **each** declaration, separately.
   *
   * An overload set's `startLine`/`endLine` are the hull from its first signature to its
   * last, which is right for *reporting* a seed but wrong for *ownership*: ambient
   * `declare function` overloads need not be contiguous, so the hull can contain
   * top-level statements that belong to no callable. Testing a line against each
   * declaration's own range instead keeps those lines unowned, so they are reported as
   * gaps rather than filtered as formatting inside an unchanged callable (§7.2 as
   * amended 2026-10-21).
   */
  readonly ranges: readonly DeclarationRange[];
  /**
   * The tokens this declarator shares with its siblings — the declaration keyword and
   * statement modifiers — or `""` when it shares none.
   *
   * Reported so a change to them can seed **every** declarator the statement declares,
   * not only the one whose line the diff touched (§8.2 as amended 2026-10-22).
   */
  readonly sharedTokens: string;
  /** Identifies the declaring statement, so siblings can be found. `""` when there is none. */
  readonly statementId: string;
  /**
   * The declaring statement's own line span, or `0`s when there is none.
   *
   * Wider than `ranges`, which covers only this declarator. A change to the shared part
   * of the statement — the keyword on its own line — falls inside no declarator, so it
   * needs the statement's span to be attributed at all.
   */
  readonly statementStartLine: number;
  readonly statementEndLine: number;
  /**
   * The declaration's tokens with formatting removed, as a single string.
   *
   * Comparing these across snapshots is how a reformatting-only change is told from a
   * real one. Comments are **included**: a JSDoc edit is a modification, because a
   * comment can state a contract callers rely on.
   */
  readonly tokenSignature: string;
}

/** Two or more declarations in one snapshot that compute the same key. */
export interface IdentityCollision {
  readonly key: string;
  readonly filePath: string;
  /** 1-based start line of each colliding declaration, in source order. */
  readonly lines: readonly number[];
  /**
   * The full line span of each colliding declaration.
   *
   * Needed because a change *inside* a colliding callable is accounted for by that
   * callable's `ambiguous-identity` gap (§8.2 as ruled 2026-10-21). Start lines alone
   * cannot answer "does this changed line fall inside one of them", so reporting such a
   * line as an unmapped change would contradict the gap already describing it.
   */
  readonly spans: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
}

export interface CallableIndex {
  /** Callables with a unique key, sorted by key. */
  readonly callables: readonly Callable[];
  /** Keys that appeared more than once. These are **not** in `callables`. */
  readonly collisions: readonly IdentityCollision[];
}

/**
 * Enumerates the callables nidan can establish an identity for, across a snapshot.
 *
 * A declaration whose identity cannot be established is not an error and not a guess — it
 * is simply absent here, and the change that touched it becomes an `unmapped-change` gap
 * in T2.3. That split is what keeps "could not identify" distinct from "nothing changed".
 */
export function enumerateCallables(
  sourceFiles: readonly SourceFile[],
  repoRoot: string,
): CallableIndex {
  const root = toPosixPath(repoRoot);
  const found: Callable[] = [];

  for (const sourceFile of sourceFiles) {
    const absolute = toPosixPath(sourceFile.getFilePath());
    // Declaration files are loaded so types resolve, but are never seeds (§7.1).
    if (sourceFile.isDeclarationFile()) continue;
    if (!isWithin(root, absolute)) continue;
    const filePath = absolute.slice(root.length + 1);
    // Tested on the **repository-relative** path. Testing the absolute one would exclude
    // every file in a project that merely happens to be checked out beneath a directory
    // called `node_modules` — the whole project would silently vanish from enumeration,
    // and results would depend on where the repository sits on disk.
    if (hasNodeModulesSegment(filePath)) continue;

    for (const node of sourceFile.getDescendants()) {
      const callable = toCallable(node, filePath);
      if (callable !== undefined) found.push(callable);
    }
  }

  return groupByKey(found);
}

function hasNodeModulesSegment(relativePath: string): boolean {
  return relativePath.split("/").includes(NODE_MODULES_SEGMENT);
}

/**
 * Splits the enumeration into unique callables and collisions.
 *
 * A duplicated key is dropped from `callables` rather than resolved. Picking one of two
 * declarations would be a guess, and a guessed identity produces a report about the wrong
 * code — worse than reporting that nidan could not tell (§7.2).
 */
function groupByKey(found: readonly Callable[]): CallableIndex {
  const byKey = new Map<string, Callable[]>();
  for (const callable of found) {
    const existing = byKey.get(callable.key);
    if (existing === undefined) byKey.set(callable.key, [callable]);
    else existing.push(callable);
  }

  const callables: Callable[] = [];
  const collisions: IdentityCollision[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length === 1) {
      callables.push(first);
      continue;
    }
    collisions.push({
      key,
      filePath: first.filePath,
      lines: group.map((callable) => callable.startLine).sort((a, b) => a - b),
      spans: group
        .map((callable) => ({
          start: callable.startLine,
          end: callable.endLine,
        }))
        .sort((left, right) => left.start - right.start),
    });
  }

  return {
    callables: callables.sort((left, right) => (left.key < right.key ? -1 : 1)),
    collisions: collisions.sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
  };
}

function toCallable(node: Node, filePath: string): Callable | undefined {
  if (Node.isFunctionDeclaration(node))
    return fromFunctionDeclaration(node, filePath);
  if (Node.isMethodDeclaration(node)) return fromMethod(node, filePath);
  if (Node.isConstructorDeclaration(node))
    return fromConstructor(node, filePath);
  if (Node.isVariableDeclaration(node))
    return fromVariableDeclaration(node, filePath);
  if (Node.isExportAssignment(node))
    return fromExportAssignment(node, filePath);
  // Everything else is unsupported by §6.1: anonymous callbacks, getters and setters,
  // object literal methods, and dynamically assigned properties among them.
  return undefined;
}

function fromFunctionDeclaration(
  node: FunctionDeclaration,
  filePath: string,
): Callable | undefined {
  if (isSupersededOverload(node)) return undefined;

  const name = node.getName();
  if (name === undefined) {
    // An anonymous function declaration is only reachable as a default export.
    if (!node.isDefaultExport()) return undefined;
    return build(node, filePath, "function", ANONYMOUS_DEFAULT_NAME, false);
  }
  return build(node, filePath, "function", name, false);
}

function fromMethod(
  node: MethodDeclaration,
  filePath: string,
): Callable | undefined {
  // An object literal's methods are also `MethodDeclaration` in the TypeScript AST, and
  // §6.1 lists them as unsupported. Only a class member qualifies.
  const parent = node.getParent();
  if (!Node.isClassDeclaration(parent) && !Node.isClassExpression(parent)) {
    return undefined;
  }
  if (isSupersededOverload(node)) return undefined;
  return build(node, filePath, "method", node.getName(), node.isStatic());
}

function fromConstructor(
  node: ConstructorDeclaration,
  filePath: string,
): Callable | undefined {
  if (isSupersededOverload(node)) return undefined;
  // Keyed `<Class> :: constructor :: constructor`, per the amendment to §7.2.
  return build(node, filePath, "constructor", "constructor", false);
}

/**
 * A variable is a callable only when it directly holds an arrow or function expression.
 * Anything else — a call that returns a function, a conditional, a reassignment — cannot
 * be established statically and is left out rather than guessed at (§6.1).
 */
function fromVariableDeclaration(
  node: VariableDeclaration,
  filePath: string,
): Callable | undefined {
  const initializer = node.getInitializer();
  if (initializer === undefined) return undefined;
  if (
    !Node.isArrowFunction(initializer) &&
    !Node.isFunctionExpression(initializer)
  ) {
    return undefined;
  }
  return build(node, filePath, "function", node.getName(), false);
}

/** A node that carries overloads: a function, method, or constructor declaration. */
type Overloadable =
  FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;

/**
 * Whether this declaration is an overload signature that another declaration represents.
 *
 * Overload signatures and the implementation are one logical callable (§7.1), so exactly
 * one declaration of a set must survive. When there is an implementation, that is the one.
 * When there is none — an ambient `declare function f(…)` declared twice, which is
 * ordinary code — the **first** signature is kept. Keeping all of them would make a set
 * of overloads collide with itself and raise a spurious `ambiguous-identity` gap.
 */
function isSupersededOverload(node: Overloadable): boolean {
  if (!node.isOverload()) return false;
  if (node.getImplementation() !== undefined) return true;
  const overloads = node.getOverloads();
  const first = overloads[0];
  return first !== undefined && first !== node;
}

/**
 * The declarations that make up one logical callable: every overload signature plus the
 * implementation. Used for the line span, so a diff touching only a signature still
 * lands inside the callable's range.
 */
function declarationsOf(node: Node): Node[] {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isConstructorDeclaration(node)
  ) {
    return [node];
  }
  const overloads: Node[] = [...node.getOverloads()];
  const implementation = node.getImplementation();
  if (implementation !== undefined) overloads.push(implementation);
  return overloads.length > 0 ? overloads : [node];
}

/**
 * `export default () => {}` and `export default function () {}`.
 *
 * The arrow form is an `ExportAssignment`, not a function declaration, and matches no
 * other branch. §6.1 supports anonymous default export functions, and the §7.2 amendment
 * requires that the AST form not affect the key — so both spell `default`. Missing the
 * arrow form would be a silent miss inside a supported pattern, and it is the dominant
 * spelling in React code.
 *
 * `export = x` is excluded: it is a CommonJS export form, not a declaration.
 */
function fromExportAssignment(
  node: ExportAssignment,
  filePath: string,
): Callable | undefined {
  if (!isDefaultExportedFunction(node)) return undefined;
  return build(node, filePath, "function", ANONYMOUS_DEFAULT_NAME, false);
}

/**
 * The declaration keyword and statement modifiers a declarator shares with its siblings.
 *
 * `enclosingStatement` returns the *declarator* for a multi-declarator statement, so each
 * sibling keeps its own span and signature. That left the shared `let` / `const` / `var`
 * outside **every** declarator's signature: `let a = () => 1, b = () => 2;` becoming
 * `var …` compared equal for both and was filtered as formatting, although it changes
 * scoping and TDZ semantics for both callables (§8.1 as amended 2026-10-21).
 *
 * Returns nothing for the single-declarator case, where the statement is already the
 * signature source and the keyword is included by that route.
 *
 * Sibling independence for *initializer* edits is unaffected: these tokens differ only
 * when the shared tokens themselves change, which is exactly when every declarator the
 * statement declares should be modified.
 */
function sharedStatementTokens(node: Node): string[] {
  if (!Node.isVariableDeclaration(node)) return [];
  const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (statement === undefined) return [];
  if (statement.getDeclarations().length === 1) return [];

  return [
    ...statement.getModifiers().map((modifier) => modifier.getText()),
    statement.getDeclarationKind().toString(),
  ];
}

/**
 * Whether an export assignment declares a function inline, rather than aliasing one.
 *
 * `export default foo` is an alias: the identity stays with `foo`'s own declaration.
 * Shared by the callable and container paths so the two cannot disagree about what counts
 * as a default-exported function.
 */
function isDefaultExportedFunction(node: ExportAssignment): boolean {
  if (node.isExportEquals()) return false;
  const expression = node.getExpression();
  return (
    Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)
  );
}

function build(
  node: Node,
  filePath: string,
  kind: DeclarationKind,
  name: string,
  isStatic: boolean,
): Callable {
  const containerChain = containersOf(node);
  const span = lineSpanOf(node);
  return {
    tokenSignature: tokenSignatureOf(node),
    key: buildKey(filePath, containerChain, kind, name, isStatic),
    declaration: node,
    filePath,
    containerChain,
    kind,
    name,
    isStatic,
    startLine: span.start,
    endLine: span.end,
    startPos: span.startPos,
    endPos: span.endPos,
    ranges: span.ranges,
    sharedTokens: sharedStatementTokens(node).join("\u0000"),
    statementId: statementIdOf(node),
    ...statementSpanOf(node),
  };
}

/** The declaring statement's line span, for a declarator that shares one. */
function statementSpanOf(node: Node): {
  statementStartLine: number;
  statementEndLine: number;
} {
  const none = { statementStartLine: 0, statementEndLine: 0 };
  if (!Node.isVariableDeclaration(node)) return none;
  const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (statement === undefined) return none;
  if (statement.getDeclarations().length === 1) return none;

  const sourceFile = node.getSourceFile();
  return {
    statementStartLine: sourceFile.getLineAndColumnAtPos(
      statement.getStart(true),
    ).line,
    statementEndLine: sourceFile.getLineAndColumnAtPos(statement.getEnd()).line,
  };
}

/** Identifies the multi-declarator statement a declarator belongs to, within one file. */
function statementIdOf(node: Node): string {
  if (!Node.isVariableDeclaration(node)) return "";
  const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (statement === undefined) return "";
  if (statement.getDeclarations().length === 1) return "";
  return `${node.getSourceFile().getFilePath()}:${String(statement.getStart(true))}`;
}

function buildKey(
  filePath: string,
  containerChain: readonly string[],
  kind: DeclarationKind,
  name: string,
  isStatic: boolean,
): string {
  // Assembled from segments rather than joined and then tidied. An earlier version
  // collapsed repeated spaces across the whole key, which merged two legitimately
  // distinct paths — `src/dup  space.ts` and `src/dup space.ts` — into one key. No
  // transformation may touch user-controlled text.
  const chain = containerChain.join(CONTAINER_SEPARATOR);
  const head = chain === "" ? `${filePath} ::` : `${filePath} :: ${chain}`;
  const key = `${head} :: ${kind} :: ${name}`;
  return isStatic ? `${key} :: static` : key;
}

/**
 * The enclosing classes and callables, outermost first.
 *
 * This is what separates two nested functions that share a name. Only containers that are
 * themselves nameable appear: an anonymous callback contributes nothing, so a function
 * declared inside one is attributed to the nearest named container above it.
 */
function containersOf(node: Node): string[] {
  const containers: string[] = [];
  for (const ancestor of node.getAncestors()) {
    const containerName = containerNameOf(ancestor);
    if (containerName !== undefined) containers.push(containerName);
  }
  // getAncestors walks outward from the node, so reverse for outermost-first.
  return containers.reverse();
}

function containerNameOf(node: Node): string | undefined {
  if (Node.isClassDeclaration(node)) return classNameOf(node);
  // A class expression is usually assigned to a variable; its own name wins when it has
  // one, so `const K = class Named {}` chains as `Named` rather than `K`.
  if (Node.isClassExpression(node)) {
    return node.getName() ?? assignedVariableName(node);
  }
  if (Node.isModuleDeclaration(node)) return node.getName();
  if (Node.isFunctionDeclaration(node)) {
    return (
      node.getName() ??
      (node.isDefaultExport() ? ANONYMOUS_DEFAULT_NAME : undefined)
    );
  }
  if (Node.isMethodDeclaration(node)) return node.getName();
  if (Node.isConstructorDeclaration(node)) return "constructor";
  // The same callable `fromExportAssignment` names `default`. Without this, rewriting
  // `export default function () {}` as `export default () => {}` silently changes every
  // nested callable's key — and can collide them with a top-level namesake.
  if (Node.isExportAssignment(node)) {
    return isDefaultExportedFunction(node) ? ANONYMOUS_DEFAULT_NAME : undefined;
  }
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    const holdsFunction =
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer));
    return holdsFunction ? node.getName() : undefined;
  }
  return undefined;
}

function classNameOf(node: ClassDeclaration): string | undefined {
  return (
    node.getName() ??
    (node.isDefaultExport() ? ANONYMOUS_DEFAULT_NAME : undefined)
  );
}

/**
 * The declaration's tokens, joined, with whitespace between them dropped.
 *
 * Tokens come from the **parsed AST**, not from re-scanning the text. A bare
 * `ts.createScanner` has no parser context: after a `${…}` substitution it resumes in
 * normal mode rather than scanning a template continuation, and it reads `/` as a divide
 * operator rather than starting a regular expression. In both cases the literal's own
 * whitespace is treated as separator and discarded, so `` `a ${x}  b` `` and
 * `` `a ${x} b` `` — different strings — compare equal. Leaf nodes carry each literal as
 * one token with its text intact.
 *
 * Comments are included, because §8.1 makes a comment edit a modification: a comment can
 * state a contract callers rely on. Leading trivia alone is not enough — a comment
 * following code on the same line trails its token and leads nothing — so both ranges are
 * collected and deduplicated by position.
 */
function tokenSignatureOf(node: Node): string {
  const declarations = declarationsOf(node).map((declaration) =>
    Node.isVariableDeclaration(declaration)
      ? enclosingStatement(declaration)
      : declaration,
  );

  const tokens: string[] = [...sharedStatementTokens(node)];
  const seenComments = new Set<number>();
  for (const declaration of declarations) {
    for (const leaf of leafTokensOf(declaration)) {
      // Leading *and* trailing. A comment after a statement on the same line is not
      // leading trivia of any later token, so collecting only leading ranges drops it —
      // and a changed `// contract` note would be filtered as formatting, which §8.1
      // forbids. Positions are deduplicated because one comment can be trailing trivia
      // of one token and leading trivia of the next.
      for (const comment of [
        ...leaf.getLeadingCommentRanges(),
        ...leaf.getTrailingCommentRanges(),
      ]) {
        if (seenComments.has(comment.getPos())) continue;
        seenComments.add(comment.getPos());
        tokens.push(comment.getText());
      }
      tokens.push(leaf.getText());
    }
  }

  // A separator no token can contain, so two different token sequences cannot join into
  // the same signature.
  return dropTrailingCommas(tokens).join("\u0000");
}

/** The declaration's leaf nodes in source order — one entry per token. */
function leafTokensOf(declaration: Node): Node[] {
  return declaration
    .getDescendants()
    .filter((descendant) => descendant.getChildCount() === 0);
}

/**
 * Removes a comma that sits immediately before a closing bracket.
 *
 * §8.1's filter is formatting-only, and ignores exactly two things: whitespace, and a
 * trailing comma immediately before a closing bracket. The comma is in the list because
 * a formatter does not only move whitespace — wrapping an argument list adds one — and
 * without it every reflow would be a modification, which is the one job the approved
 * `seed-whitespace-only` fixture says the filter must do.
 *
 * The list is **closed**. Quotes, semicolons, and parentheses stay significant even
 * where a formatter may change them, because each can change meaning; a filter that
 * grows by analogy stops being a filter.
 *
 * A trailing comma carries no meaning in any position JavaScript allows one, so dropping
 * it cannot hide a behavioural change. The narrowness matters: only a comma whose *next*
 * token closes the bracket is removed, so an array hole survives — `[1, ,]` has length 2
 * and `[1,]` has length 1, and they keep different signatures because the hole's comma is
 * followed by another comma rather than by `]`.
 */
function dropTrailingCommas(tokens: readonly string[]): string[] {
  return tokens.filter((token, index) => {
    if (token !== ",") return true;
    const next = tokens[index + 1];
    return next !== ")" && next !== "]" && next !== "}";
  });
}

/** The variable an expression is assigned to, when it is assigned directly to one. */
function assignedVariableName(node: Node): string | undefined {
  const parent = node.getParent();
  return parent !== undefined && Node.isVariableDeclaration(parent)
    ? parent.getName()
    : undefined;
}

/**
 * The declaration's full line span, including leading JSDoc and decorators (§8.1).
 *
 * For a variable holding a function, the JSDoc attaches to the enclosing statement rather
 * than to the declaration, so the statement is measured. Without that, a documentation
 * change above `const fn = () => {}` would fall outside the callable's range and become
 * an unmapped change instead of a modification.
 */
function lineSpanOf(node: Node): {
  start: number;
  end: number;
  startPos: number;
  endPos: number;
  ranges: DeclarationRange[];
} {
  const sourceFile = node.getSourceFile();
  // The span covers every declaration of the callable, so an edit to an overload
  // signature falls inside it. Spanning only the implementation would turn a signature
  // change into an unmapped change — losing exactly the usage report a signature change
  // most needs.
  const spanNodes = declarationsOf(node).map((declaration) =>
    Node.isVariableDeclaration(declaration)
      ? enclosingStatement(declaration)
      : declaration,
  );

  const ranges = spanNodes.map((spanNode) => {
    const start = spanNode.getStart(true);
    const end = spanNode.getEnd();
    return {
      startLine: sourceFile.getLineAndColumnAtPos(start).line,
      endLine: sourceFile.getLineAndColumnAtPos(end).line,
      startPos: start,
      endPos: end,
    };
  });

  const startPos = Math.min(...ranges.map((range) => range.startPos));
  const endPos = Math.max(...ranges.map((range) => range.endPos));

  return {
    start: sourceFile.getLineAndColumnAtPos(startPos).line,
    end: sourceFile.getLineAndColumnAtPos(endPos).line,
    startPos,
    endPos,
    ranges,
  };
}

/**
 * The statement around a variable declaration, used so leading JSDoc falls inside the
 * callable's span.
 *
 * Only when the statement declares one thing. `const a = () => {}, b = () => {};` would
 * otherwise give `a` and `b` the same span, and a change to either would seed both.
 */
function enclosingStatement(node: VariableDeclaration): Node {
  const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (statement === undefined) return node;
  return statement.getDeclarations().length === 1 ? statement : node;
}
