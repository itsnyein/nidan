# Supported patterns

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

This page defines what nidan resolves with compiler evidence. The [core guarantee](concepts.md#core-guarantee) applies within these patterns, and only within them. Anything outside is covered in [Limitations](limitations.md).

nidan supports single-package projects containing `.js`, `.jsx`, `.ts`, and `.tsx` files.

## Callables that can be seeds

A seed is a changed callable. Only these declaration forms can become seeds:

| Form                                                   | Example                                           |
| ------------------------------------------------------ | ------------------------------------------------- |
| Named function declaration                             | `function parseConfig() {}`                       |
| Named variable holding an arrow or function expression | `const parseConfig = () => {}`                    |
| Class instance method                                  | `class A { run() {} }`                            |
| Class static method                                    | `class A { static create() {} }`                  |
| Class constructor                                      | `class A { constructor() {} }`                    |
| Named default function declaration                     | `export default function parseConfig() {}`        |
| Anonymous default export function                      | `export default function () {}` — named `default` |

These forms are **not** supported as seeds:

- anonymous callbacks
- getters and setters
- functions returned by a factory
- dynamically assigned properties
- object literal methods

A change inside an unsupported callable is not lost. It seeds the enclosing supported callable, or produces an `unmapped-change` gap. See [attribution](#attribution).

## Usage relations

Each reported usage carries one relation.

| Relation          | Patterns                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `invoke`          | `fn()`, `obj.method()`, `obj["method"]()`, `Class.staticMethod()`                                                        |
| `construct`       | `new Class()`, and `super()` in a subclass                                                                               |
| `jsx-render`      | `<Comp />`, `<UI.Card />` — intrinsic elements and fragments are excluded                                                |
| `value-reference` | A callable used as a value: passed as an argument, given as a prop, placed in an array, assigned, or handed to a wrapper |

A `value-reference` records the immediate use only. nidan does not follow the value any further — see [value flow is not followed](limitations.md#value-flow-is-not-followed).

```tsx
const Row = () => <button onClick={handleSave} />; // value-reference on handleSave
const Card = memo(Panel); // value-reference on Panel
items.map(formatRow); // value-reference on formatRow
formatRow(item); // invoke
```

A member call written with a **literal** key is the same usage as the dotted form: `obj["method"]()`, ``obj[`method`]()``, and `obj.method()` all name the same member and all report `invoke`. A key written any other way is not discovered — including a template literal with substitutions, and including a constant whose literal type _does_ name a member; see [computed member access](limitations.md#computed-member-access-is-not-discovered).

## Module patterns

### ECMAScript modules

Named imports, default imports, namespace imports, re-exports, and barrel files are supported. A usage reached through a barrel re-export is reported once, against the original symbol.

### CommonJS

Exactly these forms are supported:

```js
require("./module");
const mod = require("./module");
const { helper } = require("./module");
module.exports.helper = helper;
exports.helper = helper;
module.exports = { helper };
```

A `require` call whose argument is not a string literal, or a `require` reached through an alias, produces a `dynamic-require` gap instead of a usage.

### Path aliases

`baseUrl` and `paths` from `tsconfig.json` or `jsconfig.json` are honored, so aliased imports such as `@/lib/format` resolve like relative ones.

### Package manager layouts

npm, pnpm, and yarn `node_modules` layouts are supported, including pnpm's symlinked `node_modules/.pnpm` structure. Yarn Plug'n'Play is not supported.

## Symbol identity

### Within a snapshot

nidan uses the canonical compiler symbol. Aliases, imports, and re-exports resolve back to the original declaration, so the same callable reached by different paths is one symbol.

Overload signatures and their implementation form a single logical callable.

`.d.ts` files are loaded so types resolve, but declarations in them are never seeds.

### Matching base against head

To tell whether a callable was added, deleted, or modified, nidan matches declarations across the two snapshots with a structural key:

```text
relativePosixPath :: containerChain :: declarationKind :: name [:: static]
```

- `containerChain` holds the enclosing classes and callables, outermost first, separated by `.` — for example `Outer.run`. It is what distinguishes nested functions that share a name. Only nameable containers appear, so a function declared inside an anonymous callback is attributed to the nearest named container above it.
- The signature is **not** part of the key, so changing parameters or return type is a modification rather than a delete plus an add.
- A named default export is keyed by its local name. An anonymous default export is keyed as `default`. In `export default foo`, the default is an alias, so the identity is `foo`.

`declarationKind` is one of exactly three values:

| Kind          | Covers                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `function`    | Named function declarations, named variables holding an arrow or function expression, and named or anonymous default exports |
| `method`      | Instance and static methods. A static method carries the trailing `:: static`                                                |
| `constructor` | A class constructor, keyed as `<path> :: <Class> :: constructor :: constructor`                                              |

The `static` marker belongs to a method's own key and is **not** part of the container
chain. A consequence worth knowing: two functions with the same name, nested inside a
static and an instance method that also share a name, produce the same key and are
reported as an [ambiguous identity](limitations.md#duplicate-identity-keys-stop-matching)
rather than matched.

**How a callable is written does not affect its key.** `function` deliberately spans
several syntactic forms, so rewriting a function declaration as an arrow-expression
variable is a modification:

```ts
// before
export function formatRow(value: string): string {
  return value.trim();
}

// after — same key, reported as modified
export const formatRow = (value: string): string => {
  return value.trim();
};
```

Keying these differently would report the change as a deletion plus an addition, and the
usage report — the thing you most want when changing a declaration — would be split across
two entries drawn from different snapshots.

If one snapshot contains the same key twice, nidan does **not** match the declarations. It emits an `ambiguous-identity` gap rather than guessing which is which.

### Constructors

A changed constructor is resolved through its class symbol, using the `construct` relation. Both `new Class()` and a subclass's `super()` are found.

## What counts as a change

### Overlap

A diff hunk that overlaps any part of a callable's full range makes that callable a candidate. The full range includes the leading JSDoc comment, decorators, the signature, and the body.

### Formatting filter

nidan compares the base and head token streams of the callable, ignoring exactly two
things:

- **whitespace**, and
- **a trailing comma immediately before a closing `)`, `]`, or `}`**.

If what remains is equal, the callable is not a seed — reformatting alone never produces
results. The trailing comma is in the list because a formatter adds one when it wraps an
argument list, so ignoring whitespace alone would make every reflow a modification.

**That list is closed.** Quotes, semicolons, and parentheses stay significant even where a
formatter may change them, because each can change meaning. An array hole also survives
the comma rule: its comma is followed by another comma rather than by `]`, so `[1, ,]`
with two elements and `[1,]` with one keep different signatures.

Comment changes, including JSDoc and pragma comments, **do** count as a modification. They sit inside the callable's range and can carry meaning.

### Attribution

- **Only the innermost supported callable is seeded.** When a change sits inside a nested function, the outer function is not seeded for it; the outer function's dependency shows up as a usage of the inner one.
- A change inside an **unsupported** callable, such as an anonymous callback, seeds the nearest enclosing supported callable.
- A change inside a callable whose [identity is ambiguous](limitations.md#duplicate-identity-keys-stop-matching) does the same: that callable is skipped, attribution continues outward to the next enclosing supported callable, and the ambiguous-identity gap is reported as well. Seeding a callable nidan cannot identify would attribute the change to one of two declarations arbitrarily.
- A hunk that maps to no callable produces an `unmapped-change` gap. This covers top-level statements, type and interface declarations, getters and setters, and any code with no enclosing callable.
- An **overload set** owns each declaration's own range, not the span from its first signature to its last. Ambient `declare function` overloads need not be contiguous, so a statement written between two signatures belongs to no callable and is reported as a gap.

### Insertions, deletions, and where a change belongs

A diff can describe a change as a _position between two lines_ rather than a span — that is how Git reports a pure insertion or deletion. nidan reads such a position as belonging to a callable only when **both** adjacent lines lie inside that same callable.

- A line inserted inside a function body belongs to that function, and seeds it.
- A line inserted **between** two functions belongs to neither, and is reported as an `unmapped-change` gap. It is never attributed to an unchanged neighbour, which would report a function as changed when its own text did not change.

### One change, one gap

A single hunk can change a callable **and** text that belongs to no callable. nidan reports both: the callable is seeded _and_ an `unmapped-change` gap names the uncovered lines. The hunk itself is counted once.

Each contiguous run of uncovered lines gets its own gap, so a hunk leaving two separate regions unaccounted for produces two gaps rather than naming only the first.

Gaps are reported against the snapshot that holds the text:

- the **head** side for a change that exists there;
- the **base** side for deleted text with no counterpart in head — a statement removed beside a modified function is named on its own side, because no head line carries it.

A modification whose two sides describe the same edit is reported once, not twice.

### Changing a shared declaration keyword

`let a = () => 1, b = () => 2;` declares two callables in one statement. Changing the keyword — to `var`, or `const` — changes scoping and temporal-dead-zone semantics for **both**, so both are reported as modified, whichever line the diff happened to touch.

Editing only one initializer still reports only that one.

**No diff hunk is silently ignored.** Every hunk in a JavaScript or TypeScript file becomes a seed or a gap.

Files that are not JavaScript or TypeScript are ignored; only their count appears in the report.

## How usages are found

For each seed, nidan asks the TypeScript compiler for references within the usage-source snapshot.

These occurrences are found but are **not** usages, and are filtered out:

- the declaration site itself
- import and export specifiers
- type-only positions

Each reported usage records where it came from: the enclosing supported callable, or the [module node](concepts.md#vocabulary) when the reference sits in top-level code.

Every usage carries a resolution status. `exact` means the reference resolves directly to the seed symbol. `ambiguous` means the reference resolves to a group of related symbols, such as an interface member and its implementations, or to more than one candidate; the candidates are listed in the report.
