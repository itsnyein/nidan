# usage-value-position

**Proves:** a class's `extends` **expression** is ordinary code, not a type position, and
a tagged template is a call.

```
src/mix.ts    :: :: function    :: withRetry
src/client.ts :: Client :: constructor :: constructor
src/tag.ts    :: :: function    :: label
```

| Site                                                | Seed          | Relation          |
| --------------------------------------------------- | ------------- | ----------------- |
| `src/use.ts` line 5 — `withRetry(...)` in `extends` | `withRetry`   | `invoke`          |
| `src/use.ts` line 5 — `Client` as its argument      | `constructor` | `value-reference` |
| `src/use.ts` line 7 — ``label`hello` ``             | `label`       | `invoke`          |

## Why this shape

The mixin and the tagged template are in one case because they fail the same way: each is
a **call that does not look like one** to a classifier reading the parent chain. A mixin
call hides under a node ts-morph reports as a type; a tagged template has no
`CallExpression` at all. Separating them would duplicate the module scaffolding without
separating the failure.

**The `extends` clause carries both halves of the ruling on one line.** `withRetry` is the
callee and `Client` is an argument, so the same subtree must yield two different relations.
A fix that merely stopped filtering the subtree — treating everything under `extends` as a
usage of one kind — would get one of these right and the other wrong, and only a case
containing both can tell.

`Client` is a **constructor** seed reached as a plain value: it is handed to `withRetry`
rather than constructed. That matters because the constructor rule (§7.3) resolves a
constructor through its class symbol, which is also what `new` and `super()` use — so this
pins that reaching the class symbol is not the same as constructing it.

## What this fixture freezes against

Before the ruling, all three sites were wrong **and nothing said so**:

- `withRetry` and `Client` were filtered `type-only`. ts-morph reports
  `ExpressionWithTypeArguments` as a type node, so the ancestor walk swallowed the whole
  subtree. `withRetry(Client)` is `fn()` — the first row of §6.2's pattern list — reported
  by nothing and gapped by nothing.
- ``label`hello` `` was classified `value-reference`, because the relation is decided from
  the parent chain and a tagged template has no call expression in it.
- **The differential check agreed with all three.** It accepts any filtered record at an
  occurrence's position without asking whether the reason can be true there, so a
  `type-only` record over a value position explained the occurrence away.

That last point is why this fixture is worth its weight. The other usage fixtures prove a
relation is right; this one proves a reference does not vanish. The run type-checks with
zero diagnostics, so none of it is exotic — the mixin shape is ordinary TypeScript, common
in the Node and React codebases Phase 1 targets.

## Not included

No `implements` clause and no interface `extends`. Those **are** type-only, they are
already covered elsewhere, and putting them here would blur the one line this case draws:
the heritage **name** is governed by the heritage rule, and everything inside a heritage
**expression** is not.
