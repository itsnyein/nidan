# usage-constructor-implicit

**Proves:** a subclass with **no explicit constructor** still constructs its base class, and
the `extends` clause is where that construction is reported.

```
src/client.ts :: Client :: constructor :: constructor
```

One usage: `src/plain.ts` line 3, relation `construct`, `from`
`src/plain.ts :: PlainClient :: constructor :: constructor`, marked `implicit: true`.

## Why this shape

`PlainClient` declares no constructor, so there is **no `super()` anywhere in the source**.
Every other constructor case reports the construction at a `super()` call;
[`usage-constructor-cross-file`](../usage-constructor-cross-file/README.md) and
[`identity-constructor`](../identity-constructor/README.md) both do, and both therefore
treat the `extends` clause as a filtered non-usage, because counting it as well would
report the same construction twice.

Here that reasoning inverts. Filtering the clause leaves the construction reported by
**nothing at all** — and a change that is reported by nothing is the one outcome the
project rules out in advance. So the clause itself carries the usage.

**Why `from` names a constructor that does not exist.** The key
`src/plain.ts :: PlainClient :: constructor :: constructor` has no declaration behind it:
the class has an implicit constructor, not a written one, and it appears in no callable
index. Naming the class instead would make this usage's `from` a different kind of thing
from every other usage's, and a consumer grouping usages by `from` would see two shapes
where the language has one. The implicit constructor is what runs; the key names it.

**Why `implicit: true` rather than a separate relation.** The relation is `construct`,
because that is what happens. The flag records that there is no call expression to point
at — the site is a declaration, so a reader following it will land on `extends Client`
rather than on something that looks like a call.

**The single file that subclasses, and nothing else.** No `new Client()` anywhere: with one
in the case, an implementation that found only `new` would still report one usage, and the
count would look right while the clause contributed nothing.
