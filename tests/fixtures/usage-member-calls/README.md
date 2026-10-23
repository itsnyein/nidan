# usage-member-calls

**Proves:** the three spellings of a member call — instance, static, and string-literal
element access — all report `invoke` with `exact` resolution.

```
src/client.ts :: Client :: method :: send
src/client.ts :: Client :: method :: describe :: static
```

| Site                                      | Seed       | Relation |
| ----------------------------------------- | ---------- | -------- |
| `src/use.ts` line 4 — `client.send(...)`  | `send`     | `invoke` |
| `src/use.ts` line 5 — `client["send"](…)` | `send`     | `invoke` |
| `src/use.ts` line 6 — `Client.describe()` | `describe` | `invoke` |

## Why this shape

The three calls sit on three consecutive lines of one function, against two methods of one
class. That is deliberate: `from` is identical for all three, so the only thing that can
distinguish them in the record is the site and the relation. A classifier that collapsed
two spellings into one would change the relation or lose a line, and both show up here.

**Instance and static are separated because the key distinguishes them and the call does
not.** `describe` keys with a trailing `:: static` while `send` does not, but
`client.send(...)` and `Client.describe()` are the same `PropertyAccessExpression` shape
at the call site. Freezing both pins that the static marker belongs to identity rather
than to classification — the relation is `invoke` either way.

**The element access is the case this fixture exists for.** `client["send"]("pong")`
reaches the same symbol as `client.send("ping")`: the compiler resolves a string-literal
element access to the declared member, and returns it from the reference search with
`exact` resolution. So it is the same usage, not a second kind, and not a gap.

Its reference node is a **string literal, not an identifier**, which is what makes it
worth freezing. Every other usage in every other fixture arrives as an identifier whose
parent is a property access or a call. This one arrives as a literal whose parent is an
`ElementAccessExpression`, so a classifier that decides from the parent chain alone — the
ordinary path — sees no call and falls through to the residue relation.

A **non-literal** element access, `client[name]("pong")`, is deliberately absent. It
resolves to no particular member, so the compiler's reference search never returns it and
there is nothing to classify. That is a documented limitation rather than a gap, and it
belongs with the other dynamic patterns in the coverage statement. A fixture cannot freeze
the absence of a reference the compiler never produces, so recording it here would assert
nothing.

## What this fixture does not contain

No filtered references against these seeds. The import specifier on line 1 and the
`client: Client` annotation on line 3 both reference the **class**, not either method, so
the reference search over a method symbol never returns them. Other usage fixtures pair
each usage with a filtered reference in the same file; this one cannot, and a reviewer
should not read the empty filter list as an omission.

## The harness blind spot this shape exposes

The differential check explains an occurrence by resolving the identifier at that position.
A string literal is not an identifier, so the check classifies the text inside `"send"` as
`comment-or-string` — an occurrence of the characters, not of the symbol.

That answer is right for a comment and for an ordinary string, and **wrong here**: this
literal is a genuine reference. The two outcomes are indistinguishable to the check as it
stands, so once the element-access call is reported as a usage, losing that usage again
would leave the occurrence still looking explained. It is the same shape as the `super()`
blind spot — a site the occurrence scan cannot speak for — and it needs the same kind of
answer: the check must recognise a string literal that is an element-access key resolving
to the seed, and must not accept `comment-or-string` for it.
