# identity-nested

**Proves:** `containerChain` distinguishes nested callables that share a name.

Two exported functions each contain a nested `helper`. Only `alpha`'s changes. Keys:

```
src/outer.ts :: alpha :: function :: helper      <- seeded
src/outer.ts :: beta  :: function :: helper      <- unchanged
```

Without the container chain both collapse to `src/outer.ts :: :: function :: helper`,
which is a duplicate key, and the case would report an `ambiguous-identity` gap instead of
a seed.

The usage comes from `alpha`, the enclosing supported callable — attribution seeds the
innermost supported callable, and the outer function's dependency shows up as a usage of
the inner one.
