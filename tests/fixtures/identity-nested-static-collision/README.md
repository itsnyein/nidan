# identity-nested-static-collision

**Proves:** the `static` marker lives on a method's own key, **not** in the container
chain — so same-named functions nested inside a static and an instance method of the same
name collide.

`Registry` has both `static create()` and `create()`. Each contains `function f`. The two
methods are distinguishable:

```
src/registry.ts :: Registry :: method :: create
src/registry.ts :: Registry :: method :: create :: static
```

Their nested functions are not:

```
src/registry.ts :: Registry.create :: function :: f    <- from the static method
src/registry.ts :: Registry.create :: function :: f    <- from the instance method
```

Identical. The chain records container _names_, and both containers are named `create`.

The expectation is an `ambiguous-identity` gap, not a match. This is a real limitation of
the identity model, and the honest thing is to freeze it as one: picking either `f` would
be a guess, and a guessed identity reports on the wrong code.

## The attribution rule this case fixes

The change is inside `f`, which cannot be identified — so what accounts for the hunk?

**The enclosing supported callable is seeded.** The static `create` is reported as
`modified`, and the gap records that `f` itself could not be resolved. Both appear; the
hunk counts once, against the seed.

The rule, approved after this case and recorded in specification §8.2: a change seeds the
innermost supported callable **with a unique identity**. A callable whose key collides is
skipped, attribution continues outward, and its `ambiguous-identity` gap is still
reported.

The two alternatives both lose something. Seeding `f` would attribute the change to one of
two declarations arbitrarily — a guessed identity reporting on the wrong code. Reporting
only the gap would lose a real behavioural difference: the static method genuinely returns
something different now. Reporting both loses nothing.
