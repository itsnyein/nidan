import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  enumerateCallables,
  type CallableIndex,
} from "../../../src/analysis/identity.js";

/**
 * Enumerates an in-memory project. These cases probe declaration forms rather than
 * analysis output, so they need no fixture repository and no Git.
 */
function enumerate(files: Record<string, string>): CallableIndex {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(`/repo/${path}`, text);
  }
  return enumerateCallables(project.getSourceFiles(), "/repo");
}

function keys(index: CallableIndex): string[] {
  return index.callables.map((callable) => callable.key);
}

describe("unsupported declaration forms are excluded", () => {
  it("excludes object literal methods, which share a node type with class methods", () => {
    // `Node.isMethodDeclaration` is true for both. §6.1 lists object literal methods as
    // unsupported, so only a class member qualifies.
    const index = enumerate({
      "src/a.ts":
        "export const obj = { method() {} };\nexport class C { m(): void {} }\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: C :: method :: m"]);
    expect(index.collisions).toEqual([]);
  });

  it("excludes getters, setters, and class property arrows", () => {
    const index = enumerate({
      "src/a.ts":
        "export class C {\n  arrow = () => {};\n  get g(): number { return 1; }\n  set s(v: number) {}\n}\n",
    });

    expect(keys(index)).toEqual([]);
  });

  it("excludes dependency source, which lives inside the repository root", () => {
    // `node_modules` is under the root, so the containment check does not exclude it.
    // Dependency resolution pulls a package's own .js into the program.
    const index = enumerate({
      "src/a.ts": "export function mine(): void {}\n",
      "node_modules/dep/index.js": "export function theirs() {}\n",
      "node_modules/dep/nested/deep.js": "export function alsoTheirs() {}\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: mine"]);
  });
});

describe("overload sets collapse to one callable", () => {
  it("keeps the first signature when there is no implementation", () => {
    // Ambient overloads are ordinary code. Keeping every signature would make the set
    // collide with itself and raise a spurious ambiguous-identity gap.
    const index = enumerate({
      "src/a.ts":
        "declare function ambient(x: string): void;\ndeclare function ambient(x: number): void;\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: ambient"]);
    expect(index.collisions).toEqual([]);
  });

  it("spans the whole set, so editing a signature lands inside the callable", () => {
    // Spanning only the implementation turns a signature change into an unmapped change,
    // losing exactly the usage report a signature change most needs.
    const index = enumerate({
      "src/a.ts":
        "export function f(x: string): void;\nexport function f(x: number): void;\nexport function f(x: unknown): void {}\n",
    });

    expect(index.callables[0]?.startLine).toBe(1);
    expect(index.callables[0]?.endLine).toBe(3);
  });
});

describe("containers that are not class declarations", () => {
  it("names a class expression by its own name, or by the variable holding it", () => {
    const index = enumerate({
      "src/a.ts":
        "export const Klass = class Named { m(): void {} };\nexport const Anon = class { m(): void {} };\n",
    });

    // Without this, both methods get an empty chain, collide, and are both dropped.
    expect(keys(index)).toEqual([
      "src/a.ts :: Anon :: method :: m",
      "src/a.ts :: Named :: method :: m",
    ]);
    expect(index.collisions).toEqual([]);
  });

  it("names a namespace", () => {
    const index = enumerate({
      "src/a.ts": "namespace NS {\n  export function inNs(): void {}\n}\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: NS :: function :: inNs"]);
  });
});

describe("a default-exported function is a container for what it holds", () => {
  it.each([
    [
      "a function expression",
      "export default function () {\n  function helper(): void {}\n}\n",
    ],
    ["an arrow", "export default () => {\n  function helper(): void {}\n};\n"],
  ])("names the container `default` for %s", (_label, source) => {
    // Both forms declare the same callable, so both must name their descendants the
    // same way. Otherwise rewriting one as the other silently re-keys everything
    // nested inside it.
    const index = enumerate({ "src/a.ts": source });

    expect(keys(index)).toContain("src/a.ts :: default :: function :: helper");
  });

  it("does not collide a nested helper with a top-level namesake", () => {
    // The consequence of getting the container wrong: the nested helper loses its chain,
    // matches the top-level `helper`, and both are dropped as a false collision — two
    // supported callables silently gone, with no change to either.
    const index = enumerate({
      "src/a.ts":
        "export function helper(): void {}\nexport default () => {\n  function helper(): void {}\n};\n",
    });

    expect(keys(index)).toEqual([
      "src/a.ts :: :: function :: default",
      "src/a.ts :: :: function :: helper",
      "src/a.ts :: default :: function :: helper",
    ]);
    expect(index.collisions).toEqual([]);
  });
});

describe("dependency exclusion is relative to the repository", () => {
  it("keeps project files when the checkout path itself contains node_modules", () => {
    // Someone whose repository sits under a directory called `node_modules` — a vendored
    // checkout, a test harness — would otherwise have every callable excluded, and omen
    // would report an empty analysis rather than an error.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/work/node_modules/app/src/a.ts",
      "export function mine(): void {}\n",
    );
    project.createSourceFile(
      "/work/node_modules/app/node_modules/dep/index.js",
      "export function theirs() {}\n",
    );

    const index = enumerateCallables(
      project.getSourceFiles(),
      "/work/node_modules/app",
    );

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: mine"]);
  });

  it("produces identical keys under two different checkout paths", () => {
    const source = { "src/a.ts": "export function mine(): void {}\n" };
    const plain = enumerate(source);

    const nested = new Project({ useInMemoryFileSystem: true });
    nested.createSourceFile(
      "/work/node_modules/app/src/a.ts",
      source["src/a.ts"],
    );
    const nestedIndex = enumerateCallables(
      nested.getSourceFiles(),
      "/work/node_modules/app",
    );

    expect(keys(nestedIndex)).toEqual(keys(plain));
  });
});

describe("default exports", () => {
  it("keys a default-exported arrow as default", () => {
    // An ExportAssignment, not a function declaration. The dominant spelling in React
    // code, and §7.2 requires that the AST form not reach the key.
    const index = enumerate({ "src/a.ts": "export default () => {};\n" });

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: default"]);
  });

  it("keys a default-exported function expression as default", () => {
    const index = enumerate({
      "src/a.ts": "export default function () {};\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: default"]);
  });

  it("treats export default of a named binding as an alias, not a declaration", () => {
    const index = enumerate({
      "src/a.ts": "function toSlug(): void {}\nexport default toSlug;\n",
    });

    expect(keys(index)).toEqual(["src/a.ts :: :: function :: toSlug"]);
  });
});

describe("the key never transforms user-controlled text", () => {
  it("keeps two paths that differ only by repeated spaces distinct", () => {
    // An earlier version collapsed repeated spaces across the whole key, merging these
    // into one and raising a false collision whose reported file depended on
    // enumeration order.
    const index = enumerate({
      "src/dup  space.ts": "export function f(): void {}\n",
      "src/dup space.ts": "export function f(): void {}\n",
    });

    expect(keys(index)).toEqual([
      "src/dup  space.ts :: :: function :: f",
      "src/dup space.ts :: :: function :: f",
    ]);
    expect(index.collisions).toEqual([]);
  });
});

describe("line spans", () => {
  it("gives each declarator of a multi-declarator statement its own span", () => {
    // One statement, two declarators, split across lines. Widening every declaration to
    // its enclosing statement would give both the same span, so a change to one would
    // seed both. Two separate `const` statements would not test that at all.
    const index = enumerate({
      "src/a.ts": "const a = () => {},\n  b = () => {\n    return 1;\n  };\n",
    });

    const byName = new Map(
      index.callables.map((callable) => [callable.name, callable]),
    );
    expect(byName.get("a")?.startLine).toBe(1);
    expect(byName.get("a")?.endLine).toBe(1);
    expect(byName.get("b")?.startLine).toBe(2);
    expect(byName.get("b")?.endLine).toBe(4);
  });

  it("keeps the leading JSDoc for a single-declarator statement", () => {
    // The other half of the rule: widening to the statement is what puts a doc comment
    // inside the callable's span, so it must still happen when there is one declarator.
    const index = enumerate({
      "src/a.ts": "/** doc */\nexport const f = () => {\n  return 1;\n};\n",
    });

    expect(index.callables[0]?.startLine).toBe(1);
    expect(index.callables[0]?.endLine).toBe(4);
  });
});
