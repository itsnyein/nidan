# usage-barrel-two-hops

**Proves:** a usage that reaches a seed through **two** re-export hops is reported once,
at the call site, not once per hop.

```
src/greet.ts :: :: function :: greet
```

One usage, in `src/use.ts` at line 4, `from src/use.ts :: :: function :: report`.

## Why this shape

The module chain is four files deep:

```
src/greet.ts          declares greet
src/inner/index.ts    export { greet } from "../greet.js";     hop 1
src/index.ts          export { greet } from "./inner/index.js"; hop 2
src/use.ts            import { greet } from "./index.js";      the call site
```

**Two hops, not one.** [`identity-re-export`](../identity-re-export/README.md) already
freezes the one-hop barrel, and it is satisfied by an implementation that reports a usage
per _distinct declaration_ of the symbol as well as by one that reports a usage per _call
site_ — with one hop both answers are one. At two hops they diverge: per-hop reporting
gives two or three, per-call-site gives one. Only the second hop makes the fixture able to
tell them apart, and it is the shape a real barrel has, since a package index re-exports a
feature index which re-exports the module.

The rule is one usage per actual call site, regardless of hop count. Duplicates across
hops are a defect, not an accepted shape.

**Three filtered references, three different kinds.** Running the compiler's
`findReferences` over `greet` in this case returns five results: the declaration, an
`ExportSpecifier` in each of the two barrels, the `ImportSpecifier` in `use.ts`, and the
call. Four of the five are filtered as non-usages and one survives. A fixture whose only
filtered reference was an import specifier could not distinguish "export specifiers are
filtered" from "export specifiers are never reached".

The two barrels sit at different directory depths so their specifiers are spelled
differently (`../greet.js` and `./inner/index.js`), which keeps a filter that matched on
the specifier text from passing by coincidence.
