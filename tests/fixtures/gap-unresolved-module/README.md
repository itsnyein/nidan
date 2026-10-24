# gap-unresolved-module

**Proves:** an import specifier that cannot be resolved produces a repo-wide
`unresolved-module` gap, and does not stop the resolvable imports in the same file from
being analysed.

```
src/greet.ts :: :: function :: greet
```

| Site                                           | Expected                      |
| ---------------------------------------------- | ----------------------------- |
| `src/use.ts` line 2 — `from "missing-package"` | repo-wide `unresolved-module` |
| `src/use.ts` line 6 — `greet()`                | `invoke`, `exact`             |

## Why this shape

**One file, one broken import, one working one.** The usage on line 6 is what makes the
gap meaningful: a run that degraded the whole file on an unresolved specifier would
produce the gap and lose a usage that resolves perfectly well, and the report would be
quietly less complete than it looks.

The `@ts-expect-error` is deliberate. The package is absent **by design** — that is the
condition under test — and without the suppression the case would not compile, which
would make the result a measurement of error recovery rather than of gap reporting.

## Why repo-wide

The unresolved specifier is a property of the module graph, not of any seed. `greet` is
not involved in it; the import would be equally unresolved with no seeds at all.

## Current behaviour

Probed, zero diagnostics: the usage on line 6 is already reported, **no gap** is emitted,
and nothing is unexplained.
