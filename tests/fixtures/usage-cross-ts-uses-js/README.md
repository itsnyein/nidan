# usage-cross-ts-uses-js

**Proves:** a JavaScript callable used from TypeScript reports the same `resolution.status`
as the all-TypeScript case — `exact`.

```
src/greet.js :: :: function :: greet
```

One usage, in `src/use.ts` at line 4, `from src/use.ts :: :: function :: report`.

## Why this shape

The seed is in `.js` and the usage is in `.ts`, which is the direction that can differ.
Going the other way the compiler has a declaration to resolve against; here it has only
what it infers from JavaScript, so whether the reference resolves to the seed symbol at
all is decided by inference rather than by the source.

The sources are the same as the equivalence group's, deliberately: this fixture and
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) differ in **one** file's
extension, so the comparison between them isolates the language boundary and nothing else.
The documented limit of that comparison is that `resolution.mechanism` is experimental and
may differ; `status` may not.

**A reference that does not resolve must become a gap, never nothing.** That is the point
of pinning `exact` here rather than leaving the case unwritten: the failure this guards
against is not a wrong status but a usage that silently disappears — a change that is
reported by nothing at all, which is the shape every miss found so far has had.

`checkJs` is on for the reason given in
[`usage-equivalence-js`](../usage-equivalence-js/README.md) — with checking off, a
difference in outcome could be blamed on the JavaScript not being checked rather than on
the language boundary.
