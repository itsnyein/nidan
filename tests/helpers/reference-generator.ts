/**
 * Seeded generator for reference-discovery cases.
 *
 * The hand-written fixtures each test one shape deliberately. This generates
 * *combinations* nobody thought to write down, and holds every one to the differential
 * check: every text occurrence of the seed's name is explained, or the case fails. That
 * invariant needs no golden expectation, which is what makes generated input usable here
 * at all.
 */

import type { Relation } from "../../src/analysis/references.js";

/** The seed a case is built around. */
export type SeedKind = "function" | "class" | "method" | "component";

/** A reference shape a case may contain. Asserted reachable by the suite. */
export type Shape =
  | "direct-call"
  | "one-hop"
  | "two-hops"
  | "type-position"
  | "shadowed-local"
  | "same-name-other-module"
  | "interface-typed-receiver"
  | "concrete-member-call"
  | "held-as-value"
  | "jsx-direct-tag"
  | "jsx-member-tag"
  | "subclass-with-constructor"
  | "subclass-without-constructor"
  | "comment-occurrence"
  | "string-occurrence";

/** How many usages of each relation a case was built to contain. */
export type RelationCounts = Readonly<Record<Relation, number>>;

export interface GeneratedCase {
  readonly base: Record<string, string>;
  readonly head: Record<string, string>;
  /** Reproducible description, used in failure messages. */
  readonly description: string;
  /** The shapes this case actually contains, for the coverage assertion. */
  readonly shapes: ReadonlySet<Shape>;
  /** Whether the case contains JSX, so the harness can configure the compiler for it. */
  readonly jsx: boolean;
  /**
   * The usages, **by relation**, the case was built to contain.
   *
   * Derived from what the generator emitted, never from what nidan reported — a count
   * taken from the tool asserts that the tool does what it does. This is the one check
   * that catches over-reporting precisely rather than structurally: the differential
   * invariant cannot see an extra usage, because an extra usage explains its own
   * occurrence.
   *
   * Per relation rather than a single total, because a total cannot see a
   * *misclassification*: reporting a rendered component as a value reference keeps the
   * count right, explains its own occurrence, and changes the one field the report is
   * read for.
   */
  readonly expectedRelations: RelationCounts;
}

function noRelations(): Record<Relation, number> {
  return { invoke: 0, construct: 0, "jsx-render": 0, "value-reference": 0 };
}

export interface Random {
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/**
 * mulberry32, written out rather than taken from a dependency.
 *
 * `AGENTS.md` forbids adding one for this, and `Math.random` cannot be seeded — a failure
 * that cannot be reproduced trains everyone to re-run rather than investigate.
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomFrom(next: () => number): Random {
  return {
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      // Always in range; the check exists for the compiler, which cannot know that.
      if (item === undefined) throw new Error("empty pick");
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

const SEED_KINDS: readonly SeedKind[] = [
  "function",
  "class",
  "method",
  "component",
];

export function generateCase(random: Random, index: number): GeneratedCase {
  const kind = random.pick(SEED_KINDS);
  const name = nameFor(kind, index);
  // A method seed is reached through its interface, not through a re-export of its
  // class, so a barrel would be noise rather than a hop the seed travels.
  const hops = kind === "method" ? 0 : random.int(3);
  const shapes = new Set<Shape>();
  const notes: string[] = [`${kind}#${String(index)}`, `hops=${String(hops)}`];
  // Counted as the case is built, so the count and the source cannot disagree.
  const counted = noRelations();
  const jsx = kind === "component";
  // A component seed is `.tsx`; everything else stays `.ts`, so only the JSX cases pay
  // for the compiler option and the runtime shim.
  const seedPath = jsx ? "src/seed.tsx" : "src/seed.ts";

  const files: Record<string, string> = {};
  const entry = buildBarrels(files, name, hops, shapes);

  if (kind === "method") {
    files[seedPath] = methodSeed(name, "first");
    buildMethodUse(files, name, random, shapes, notes, counted);
  } else if (kind === "class") {
    files[seedPath] = classSeed(name, "first");
    buildClassUse(files, name, entry, random, shapes, notes, counted);
  } else if (kind === "component") {
    files[seedPath] = componentSeed(name, "first");
    buildComponentUse(files, name, entry, random, shapes, notes, counted);
  } else {
    files[seedPath] = functionSeed(name, "first");
    buildFunctionUse(files, name, entry, random, shapes, notes, counted);
  }

  if (random.chance(0.5)) {
    files["src/other.ts"] = sameNameElsewhere(kind, name);
    shapes.add("same-name-other-module");
    notes.push("same-name-other-module");
  }

  const second = secondVariantOf(kind, name);

  return {
    base: files,
    head: { ...files, [seedPath]: second },
    description: notes.join(", "),
    shapes,
    jsx,
    expectedRelations: counted,
  };
}

function nameFor(kind: SeedKind, index: number): string {
  if (kind === "function") return `greet${String(index)}`;
  if (kind === "component") return `Panel${String(index)}`;
  return `Thing${String(index)}`;
}

function secondVariantOf(kind: SeedKind, name: string): string {
  if (kind === "method") return methodSeed(name, "second");
  if (kind === "class") return classSeed(name, "second");
  if (kind === "component") return componentSeed(name, "second");
  return functionSeed(name, "second");
}

/** Re-export chain. Returns the specifier the usage file should import from. */
function buildBarrels(
  files: Record<string, string>,
  name: string,
  hops: number,
  shapes: Set<Shape>,
): string {
  if (hops === 0) {
    shapes.add("direct-call");
    return "./seed.js";
  }
  files["src/barrel0.ts"] = `export { ${name} } from "./seed.js";\n`;
  if (hops === 1) {
    shapes.add("one-hop");
    return "./barrel0.js";
  }
  files["src/barrel1.ts"] = `export { ${name} } from "./barrel0.js";\n`;
  shapes.add("two-hops");
  return "./barrel1.js";
}

function functionSeed(name: string, variant: "first" | "second"): string {
  const body = variant === "first" ? '"one"' : '"two"';
  return `export function ${name}(): string {\n  return ${body};\n}\n`;
}

function classSeed(name: string, variant: "first" | "second"): string {
  const body = variant === "first" ? '"one"' : '"two"';
  return (
    `export class ${name} {\n  constructor(readonly label: string) {\n` +
    `    void ${body};\n  }\n}\n`
  );
}

/**
 * A class whose method implements an interface member.
 *
 * The seed is the **method**. A caller typed by the interface resolves to the interface
 * member rather than to this implementation, which is the shape that must not be reported
 * as `exact`.
 */
function methodSeed(name: string, variant: "first" | "second"): string {
  const body = variant === "first" ? '"one"' : '"two"';
  return (
    `export interface ${name}Shape {\n  run(): string;\n}\n\n` +
    `export class ${name} implements ${name}Shape {\n` +
    `  run(): string {\n    return ${body};\n  }\n}\n`
  );
}

/**
 * Calls of a method seed, through the interface it implements and optionally through the
 * concrete class.
 *
 * Both are member calls, and both are `invoke`. They differ in **resolution**, not in
 * relation: the interface-typed receiver reaches the interface member rather than the
 * changed implementation, so it is `ambiguous`, while the concrete receiver is `exact`.
 * Generating both is what stops "member call" from meaning only the ambiguous one.
 */
function buildMethodUse(
  files: Record<string, string>,
  name: string,
  random: Random,
  shapes: Set<Shape>,
  notes: string[],
  counted: Record<Relation, number>,
): void {
  const lines = [
    `import type { ${name}Shape } from "./seed.js";`,
    ``,
    `export function callIt(target: ${name}Shape): string {`,
    `  return target.run();`,
    `}`,
  ];
  shapes.add("interface-typed-receiver");
  notes.push("interface-typed-receiver");
  counted.invoke += 1;

  if (random.chance(0.5)) {
    // A receiver typed by the class itself. `new ${name}()` is a construction of the
    // class, not of the seed — the seed is the method — so it adds no usage here.
    lines.unshift(`import { ${name} } from "./seed.js";`);
    lines.push(
      ``,
      `export function callDirect(): string {`,
      `  return new ${name}().run();`,
      `}`,
    );
    counted.invoke += 1;
    shapes.add("concrete-member-call");
    notes.push("concrete-member-call");
  }

  files["src/use.ts"] = `${lines.join("\n")}\n`;
}

function buildFunctionUse(
  files: Record<string, string>,
  name: string,
  entry: string,
  random: Random,
  shapes: Set<Shape>,
  notes: string[],
  counted: Record<Relation, number>,
): void {
  const lines = [`import { ${name} } from "${entry}";`, ""];

  if (random.chance(0.5)) {
    lines.push(`// ${name} is the callable under test`);
    shapes.add("comment-occurrence");
    notes.push("comment");
  }
  if (random.chance(0.5)) {
    lines.push(`export const label = "${name}";`);
    shapes.add("string-occurrence");
    notes.push("string");
  }

  lines.push(
    `export function report(): string {`,
    `  return ${name}().toUpperCase();`,
    `}`,
  );
  counted.invoke += 1;

  if (random.chance(0.5)) {
    // Handed over as a value rather than called. The residue relation, and the one a
    // count alone cannot distinguish from the call above.
    lines.push(``, `export const held = ${name};`);
    counted["value-reference"] += 1;
    shapes.add("held-as-value");
    notes.push("held-as-value");
  }

  if (random.chance(0.5)) {
    // A local of the same name, shadowing the import inside its own function.
    lines.push(
      ``,
      `export function shadowed(): string {`,
      `  const ${name} = (): string => "local";`,
      `  return ${name}();`,
      `}`,
    );
    // No count: both occurrences resolve to the local, not to the seed.
    shapes.add("shadowed-local");
    notes.push("shadowed-local");
  }

  if (random.chance(0.5)) {
    // A pure type position: the annotation is filtered and the parameter is never the
    // seed, so this adds an occurrence to explain and no usage to count.
    lines.push(
      ``,
      `export function take(f: typeof ${name}): string {`,
      `  return f();`,
      `}`,
    );
    shapes.add("type-position");
    notes.push("type-position");
  }

  files["src/use.ts"] = `${lines.join("\n")}\n`;
}

function buildClassUse(
  files: Record<string, string>,
  name: string,
  entry: string,
  random: Random,
  shapes: Set<Shape>,
  notes: string[],
  counted: Record<Relation, number>,
): void {
  const lines = [`import { ${name} } from "${entry}";`, ""];

  if (random.chance(0.5)) {
    lines.push(`// ${name} is the class under test`);
    shapes.add("comment-occurrence");
    notes.push("comment");
  }

  lines.push(
    `export function make(): ${name} {`,
    `  return new ${name}("x");`,
    `}`,
  );
  // The `new`, which is a usage; the return annotation beside it is a type position and
  // is not.
  counted.construct += 1;
  shapes.add("type-position");

  // Exactly one of the two subclass shapes, never both: they are the two halves of the
  // heritage rule, and a case containing both cannot show which half explained what.
  if (random.chance(0.5)) {
    lines.push(
      ``,
      `export class WithCtor extends ${name} {`,
      `  constructor() {`,
      `    super("y");`,
      `  }`,
      `}`,
    );
    // The `super()` call. The clause itself is filtered in this half of the rule.
    counted.construct += 1;
    shapes.add("subclass-with-constructor");
    notes.push("subclass-with-constructor");
  } else {
    lines.push(``, `export class NoCtor extends ${name} {}`);
    // The clause itself, reported as the implicit construction.
    counted.construct += 1;
    shapes.add("subclass-without-constructor");
    notes.push("subclass-without-constructor");
  }

  files["src/use.ts"] = `${lines.join("\n")}\n`;
}

/** An independent declaration of the same name, used where it is declared. */
/**
 * A function component, which is a seed like any other named function.
 *
 * Typed against the shim's `JSX.Element` rather than a real framework: the generated
 * cases must type-check, and a dependency for that is both forbidden and unnecessary.
 */
function componentSeed(name: string, variant: "first" | "second"): string {
  const body = variant === "first" ? "props.label" : "props.label.trim()";
  return (
    `import type { JSX } from "tiny-ui";\n\n` +
    `export function ${name}(props: { label: string }): JSX.Element {\n` +
    `  return <span>{${body}}</span>;\n}\n`
  );
}

/**
 * The two tag spellings, which are the same relation reached by different parses.
 *
 * `<Panel />` is an identifier tag; `<UI.Panel />` parses as a JSX member expression.
 * Both are `jsx-render`. Generating only the first would leave the member spelling to the
 * hand-written tests alone, and it is the spelling whose classification depends on
 * walking to the outermost access.
 */
function buildComponentUse(
  files: Record<string, string>,
  name: string,
  entry: string,
  random: Random,
  shapes: Set<Shape>,
  notes: string[],
  counted: Record<Relation, number>,
): void {
  const lines = [
    `import type { JSX } from "tiny-ui";`,
    `import { ${name} } from "${entry}";`,
    ``,
    `export function AppDirect(): JSX.Element {`,
    `  return <${name} label="x" />;`,
    `}`,
  ];
  counted["jsx-render"] += 1;
  shapes.add("jsx-direct-tag");
  notes.push("jsx-direct-tag");

  if (random.chance(0.5)) {
    // A namespace import contributes no occurrence of the seed's own name, so the only
    // new occurrence is the tag itself.
    lines.splice(2, 0, `import * as UI from "${entry}";`);
    lines.push(
      ``,
      `export function AppMember(): JSX.Element {`,
      `  return <UI.${name} label="y" />;`,
      `}`,
    );
    counted["jsx-render"] += 1;
    shapes.add("jsx-member-tag");
    notes.push("jsx-member-tag");
  }

  if (random.chance(0.5)) {
    lines.push(``, `export const Held = ${name};`);
    counted["value-reference"] += 1;
    shapes.add("held-as-value");
    notes.push("held-as-value");
  }

  files["src/use.tsx"] = `${lines.join("\n")}\n`;
}

function sameNameElsewhere(kind: SeedKind, name: string): string {
  // A component is a function, so its unrelated twin is one too.
  if (kind === "function" || kind === "component") {
    return `function ${name}(): string {\n  return "unrelated";\n}\n\nexport const other = ${name}();\n`;
  }
  return `class ${name} {\n  readonly tag = "unrelated";\n}\n\nexport const other = new ${name}().tag;\n`;
}
