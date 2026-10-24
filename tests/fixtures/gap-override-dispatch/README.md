# gap-override-dispatch

**Proves:** a changed method that overrides a base-class method emits an
`interface-or-override-dispatch` gap, and a call through the base type resolves
`ambiguous`.

```
src/base.ts :: LoudReporter :: method :: render
```

| Site                                          | Expected                             |
| --------------------------------------------- | ------------------------------------ |
| `src/use.ts` line 4 — `reporter.render("x")`  | `invoke`, **`ambiguous`**            |
| `src/base.ts` line 8 — the seed's declaration | `interface-or-override-dispatch` gap |

## Why this shape, separate from the interface case

The two halves of §9's dispatch condition are different compiler relationships:
implementing an interface member is a structural obligation, overriding a base method is
inheritance. They are reported the same way, which is exactly why both need a fixture —
one case covering both would pass if either path worked.

The receiver is typed as the **base** class, so the call could reach `Reporter.render` or
`LoudReporter.render`. Nothing in the source decides it.

## Current behaviour

Probed, zero diagnostics: the call is already `ambiguous`, and **no gap is emitted**.

## Open question, same as the interface case

Whether the gap sits on the seed or on each ambiguous call site. This record follows §9's
wording and puts one on the seed's declaration. See
[`gap-interface-dispatch`](../gap-interface-dispatch/README.md) for the trade.
