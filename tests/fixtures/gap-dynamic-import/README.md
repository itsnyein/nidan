# gap-dynamic-import

**Proves:** a computed `import()` produces a repo-wide `dynamic-import` gap, while a
literal `import()` beside it resolves normally.

```
src/greet.ts :: :: function :: greet
```

| Site                                 | Expected                   |
| ------------------------------------ | -------------------------- |
| `src/use.ts` line 2 — `import(name)` | repo-wide `dynamic-import` |
| `src/use.ts` line 7 — `mod.greet()`  | `invoke`, `exact`          |

## Why this shape

The literal `import("./greet.js")` on line 6 is the control, and it is doing real work:
dynamic `import()` with a **literal** specifier is a supported module pattern, so the call
on line 7 must still be found. A change that declined every `import()` would produce the
expected gap and silently lose that usage — this fixture fails if it does.

## Current behaviour

Probed, zero diagnostics: the literal import's call is already reported `invoke`/`exact`,
**no gap** is emitted for the computed one, and nothing is unexplained.

Nothing being unexplained is the point to notice. The computed `import(name)` names no
module, so the seed's name never appears there and the occurrence scan has nothing to
catch. This fixture pins something the differential check structurally cannot.
