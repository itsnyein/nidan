# usage-constructor-cross-file

**Proves:** a changed constructor is found through the class symbol **across module
boundaries** — `new` in one file, a subclass `super()` in another.

```
src/client.ts :: Client :: constructor :: constructor
```

Two usages, both `construct`:

| Site                                    | `from`                                                         |
| --------------------------------------- | -------------------------------------------------------------- |
| `src/retry.ts` line 5 — `super(url)`    | `src/retry.ts :: RetryingClient :: constructor :: constructor` |
| `src/use.ts` line 4 — `new Client(...)` | `src/use.ts :: :: function :: makeClient`                      |

## Why this shape

[`identity-constructor`](../identity-constructor/README.md) already freezes `new` plus
`super()` with the subclass in the **same file** as the base class. Splitting them is not
a cosmetic variation: it changes how the subclass is found.

`super(url)` is not a reference to `Client` by name — the compiler's reference search over
the class symbol does not return it. The only thing that connects `RetryingClient` to
`Client` is the `extends Client` heritage clause, so reaching the `super()` call means
following that clause to the subclass and then finding the call inside it. When both
classes share a file, an implementation that merely scanned the seed's own file for
`super` calls would produce the right answer for the wrong reason. Here the subclass is in
another module, reachable only through the heritage clause, and that shortcut returns
nothing.

The relation is `construct` against the parent class and `from` is the enclosing supported
callable — the subclass constructor's key, not the subclass. The subclass constructor is
itself a supported callable, so this is the ordinary `from` rule rather than an exception
to it.

**Two references that must be filtered, and they fail differently.** `src/use.ts` line 3
annotates the return type as `Client`, a type-only position; `src/retry.ts` line 1 and
`src/use.ts` line 1 are import specifiers. Both sit in files that also contain a real
usage, so a filter that dropped either rule would report a second usage _from the same
callable_ — which reads as a genuine second call site rather than as a filter failure.

The `extends Client` clause produces no usage of its own. This fixture does not introduce
that expectation: [`identity-constructor`](../identity-constructor/README.md) contains the
same clause and already freezes two usages rather than three.
