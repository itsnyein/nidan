# gap-dynamic-require

**Proves:** both forms §6.3 declines — a computed `require` and an **aliased** `require` —
produce a `dynamic-require` gap, and that those gaps are **repo-wide** rather than
attached to a seed.

| Site                                        | Expected                                 |
| ------------------------------------------- | ---------------------------------------- |
| `src/use.js` line 6 — `require(name)`       | repo-wide `dynamic-require`, non-literal |
| `src/use.js` line 12 — `load("./greet.js")` | repo-wide `dynamic-require`, aliased     |

## Why these gaps are repo-wide

§10.1 splits gaps by whether they are **attributable to a seed**. A dynamic `require` is
the case where attribution is impossible by construction: the whole reason it is a gap is
that nothing in the source says which module is loaded, so nothing says whether the seed's
module is among them. Filing it under a seed would assert a connection the analysis
explicitly cannot make.

This is the contrast with [`gap-untyped-member-call`](../gap-untyped-member-call/README.md),
where the called name **does** match the seed and the gap belongs to it. The two fixtures
together are what pin the scope rule; either alone would let a wrong reading pass.

## Why the aliased form is here and not treated as resolvable

`const load = require;` then `load("./greet.js")` has a string literal, so a reader might
expect it to resolve. §6.3 says no, and the reason is worth stating: once `require` is a
value it can be passed, wrapped, or replaced, and following it would mean following the
value — which §12 declines everywhere else. The literal argument is a coincidence of this
call site, not a property of the pattern.

`src/node-globals.d.ts` declares `require` because the fixture installs no `@types/node`
and TypeScript special-cases only `require("literal")` in a JavaScript file. Without it
the case would not compile, and would be testing error recovery instead.

## Current behaviour

Probed, zero diagnostics: one seed, **no usages, no gaps, nothing unexplained**. Nothing
is unexplained because `greet` never appears by name in `use.js` — which is exactly why
the no-silent-miss guarantee cannot catch this one. The occurrence scan has nothing to
scan for, so the absence is invisible to it, and only an expectation can pin it.
