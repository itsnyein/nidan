# gap-interface-dispatch

**Proves:** a changed method that implements an interface member emits an
`interface-or-override-dispatch` gap, and that a call through the interface resolves
`ambiguous` while a call on the concrete class resolves `exact`.

```
src/store.ts :: FileStore :: method :: save
```

| Site                                           | Expected                             |
| ---------------------------------------------- | ------------------------------------ |
| `src/use.ts` line 5 — `store.save("x")`        | `invoke`, **`ambiguous`**            |
| `src/use.ts` line 9 — `new FileStore().save()` | `invoke`, `exact`                    |
| `src/store.ts` line 6 — the seed's declaration | `interface-or-override-dispatch` gap |

## Why this shape

**Two call sites, one seed, two different resolutions.** `MemoryStore` exists and is never
called: it is there to make the ambiguity real rather than nominal. With only one
implementer a reader could argue the interface-typed call obviously reaches `FileStore`;
with two, nothing in the source says which.

The concrete call on line 9 is the control. If a change ever made every member call
`ambiguous`, this fixture would still look correct without it.

## The ruling this fixture asks for

**Where does the dispatch gap sit — on the seed, or on each ambiguous call site?**

This record puts **one gap on the seed's declaration**, reading §9 literally: "if the seed
method implements an interface member or overrides a base method, emit an
`interface-or-override-dispatch` gap." That condition is about the seed, not about a call,
so the gap says "this callable participates in dispatch" once.

The alternative is a gap per ambiguous call site, which tells a reader _which_ calls are
uncertain — arguably more useful, and it is what `site` being a file/range suggests. The
cost is one gap per call rather than one per seed, which on a widely-implemented interface
is a large difference in report size.

## Not asserted

`resolution.candidates`. The probe shows one candidate today, and whether the list should
name the interface member or every implementation is a separate question from whether the
status is `ambiguous`. Freezing a candidate list before that is settled would freeze an
answer nobody has given.

## Current behaviour

Probed, zero diagnostics: both call sites are already classified correctly — line 5
`ambiguous`, line 9 `exact` — and **no gap is emitted**. Nothing is unexplained, because
the ambiguous usage does explain its own occurrence. So this fixture is not catching a
silent miss; it is pinning a gap that does not exist yet.
