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

export interface Callable {
  /** `relativePosixPath :: containerChain :: declarationKind :: name [:: static]` */
  readonly key: string;
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
}

/** Two or more declarations in one snapshot that compute the same key. */
export interface IdentityCollision {
  readonly key: string;
  readonly filePath: string;
  /** 1-based start line of each colliding declaration, in source order. */
  readonly lines: readonly number[];
}

export interface CallableIndex {
  /** Callables with a unique key, sorted by key. */
  readonly callables: readonly Callable[];
  /** Keys that appeared more than once. These are **not** in `callables`. */
  readonly collisions: readonly IdentityCollision[];
}

/**
 * Enumerates the callables omen can establish an identity for, across a snapshot.
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
    // `node_modules` sits inside the repository root, so the check above does not
    // exclude it. Dependency resolution pulls a package's own `.js` into the program,
    // and third-party code must never become a seed or raise a gap about itself.
    if (hasNodeModulesSegment(absolute)) continue;
    const filePath = absolute.slice(root.length + 1);

    for (const node of sourceFile.getDescendants()) {
      const callable = toCallable(node, filePath);
      if (callable !== undefined) found.push(callable);
    }
  }

  return groupByKey(found);
}

function hasNodeModulesSegment(absolutePath: string): boolean {
  return absolutePath.split("/").includes(NODE_MODULES_SEGMENT);
}

/**
 * Splits the enumeration into unique callables and collisions.
 *
 * A duplicated key is dropped from `callables` rather than resolved. Picking one of two
 * declarations would be a guess, and a guessed identity produces a report about the wrong
 * code — worse than reporting that omen could not tell (§7.2).
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
  if (node.isExportEquals()) return undefined;
  const expression = node.getExpression();
  if (
    !Node.isArrowFunction(expression) &&
    !Node.isFunctionExpression(expression)
  ) {
    // `export default foo` is an alias: the identity stays with `foo`'s declaration.
    return undefined;
  }
  return build(node, filePath, "function", ANONYMOUS_DEFAULT_NAME, false);
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
    key: buildKey(filePath, containerChain, kind, name, isStatic),
    filePath,
    containerChain,
    kind,
    name,
    isStatic,
    startLine: span.start,
    endLine: span.end,
  };
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
function lineSpanOf(node: Node): { start: number; end: number } {
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

  const starts = spanNodes.map(
    (spanNode) =>
      sourceFile.getLineAndColumnAtPos(spanNode.getStart(true)).line,
  );
  const ends = spanNodes.map(
    (spanNode) => sourceFile.getLineAndColumnAtPos(spanNode.getEnd()).line,
  );
  return { start: Math.min(...starts), end: Math.max(...ends) };
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
