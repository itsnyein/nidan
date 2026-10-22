# usage-equivalence-ts

**Proves:** the `.ts` member of the four-variant equivalence group — a changed function has
one `invoke` usage, reported from the enclosing function of the only call site.

```
src/greet.ts :: :: function :: greet
```

One usage, in `src/use.ts` at line 4, `from src/use.ts :: :: function :: report`.

## Why this shape

The four variants — [`usage-equivalence-ts`](../usage-equivalence-ts/README.md),
[`-tsx`](../usage-equivalence-tsx/README.md), [`-js`](../usage-equivalence-js/README.md),
[`-jsx`](../usage-equivalence-jsx/README.md) — exist to prove the analyzer does not quietly
behave differently per file extension. That claim is only testable if the variants differ
in nothing else, so their sources are **byte-identical**:

```js
export function greet() {
  return "Hello";
}
```

Only the extension and the compiler options that extension requires differ (this variant
needs none). Two consequences shaped the source:

- **No parameters and no annotations.** A parameter would need a type annotation under
  `strict` in the `.ts`/`.tsx` variants and could not carry one in the `.js`/`.jsx` ones,
  so the variants would differ in source and a difference in result could be blamed on
  that rather than on the extension.
- **The import specifier is `./greet.js` in all four.** Under `NodeNext` that resolves to
  `greet.ts`, `greet.tsx`, `greet.js`, and `greet.jsx` alike, so even the specifier string
  is shared.

The call is `greet().toUpperCase()` rather than a bare `greet()`: a bare call statement
would make the call expression the whole statement, and a `from` rule that returned the
statement rather than the enclosing callable would still look right.

The `import { greet }` specifier on line 1 is a reference to the symbol and **not** a
usage, so a fixture with a single call site expects exactly one usage. Two would mean the
import specifier survived the filter.
