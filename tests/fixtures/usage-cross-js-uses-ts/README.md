# usage-cross-js-uses-ts

**Proves:** a TypeScript callable used from JavaScript reports the same `resolution.status`
as the all-TypeScript case — `exact`.

```
src/greet.ts :: :: function :: greet
```

One usage, in `src/use.js` at line 4, `from src/use.js :: :: function :: report`.

## Why this shape

The reverse direction of
[`usage-cross-ts-uses-js`](../usage-cross-ts-uses-js/README.md), and it fails differently.
There the risk is that the compiler cannot infer enough from JavaScript to resolve the
reference. Here the seed resolves fine — the risk is that the **usage file** is skipped:
an implementation that searches only TypeScript files, or that derives the files to search
from the seed's own extension, finds nothing and reports a seed with zero usages.

Zero usages is a plausible-looking report. Nothing about it says a file was never
searched, which is why both directions need a fixture rather than one standing in for the
other.

The `from` key is `src/use.js :: :: function :: report`: the enclosing supported callable,
and it is in a JavaScript file, so the callable enumerator has to produce keys for
JavaScript as well — asserted here by the key's own spelling.

`checkJs` is on for the reason given in
[`usage-equivalence-js`](../usage-equivalence-js/README.md).
