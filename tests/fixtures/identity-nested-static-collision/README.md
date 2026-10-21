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

## The open question in this case

The change is inside `f`, which cannot be identified — so what happens to the hunk?

This fixture expects the **enclosing supported callable to be seeded**: the static
`create` is reported as `modified`, and the gap records that `f` itself could not be
resolved. The reasoning is that §8.2 already says a change inside an _unsupported_
callable seeds the enclosing supported one, and a callable whose identity is ambiguous is
in the same position — omen cannot identify it, so attribution moves outward.

The alternative reading is that the gap alone accounts for the hunk and nothing is seeded.
That satisfies "no hunk silently ignored" too, but it loses a real behavioural change: the
static method genuinely returns something different now.

**This needs a ruling.** It is the one thing in this fixture the specification does not
settle, and it freezes on merge.
