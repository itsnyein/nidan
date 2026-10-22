# seed-declaration-keyword-one-line

**Proves:** the same ruling as [`seed-declaration-keyword`](../seed-declaration-keyword/README.md)
— the declaration keyword is part of every declarator's token signature — on the shape the
M2 milestone review used to reproduce it: **both declarators on one line**.

`let a = () => 1, b = () => 2;` becomes `var a = …, b = …;`. Both `a` and `b` are seeded
`modified`.

**Why both shapes exist.** They separate the ruling's two mechanisms. Measured by
mutation:

| Mutation                              | two-line | one-line   |
| ------------------------------------- | -------- | ---------- |
| Shared tokens dropped from signatures | fails    | fails      |
| Sibling propagation removed           | fails    | **passes** |

The one-line shape is the **control**. Both declarators lie on the changed line, so
per-line attribution reaches both and the signature half alone suffices — which is what
isolates the work propagation does in the two-line shape, where only `a` is on the changed
line and `b` is seeded solely by propagation.

An earlier draft of this file claimed the one-line fixture guarded the signature half
_independently_, so that a regression there "could hide behind the propagation". The first
row disproves that: break signatures and both fail together. The real value is narrower —
it pins the boundary between the two mechanisms, so a future change that quietly made
propagation load-bearing for the simple case would show up here.

Measured side by side before the propagation rule existed:

```
one-line  hunks=1  seeds=["a modified","b modified"]
two-line  hunks=1  seeds=["a modified"]
```

The two-line shape is what exposed propagation; this one marks where it stops being
needed.
