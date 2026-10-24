# gap-untyped-member-call

**Proves:** a member call matching the seed's name on an `any`-typed receiver emits an
`untyped-member-call` gap, rather than being reported as a usage or dropped.

```
src/client.ts :: Client :: method :: send
```

| Site                                 | Expected                  |
| ------------------------------------ | ------------------------- |
| `src/use.ts` line 4 — typed receiver | `invoke`, `exact`         |
| `src/use.ts` line 8 — `any` receiver | `untyped-member-call` gap |

## Why this shape

Both functions call `.send(...)`, one line apart, differing **only** in the receiver's
type. A gap that fired on both would be indistinguishable from a gap that fired on
neither-plus-noise; the typed call is what makes the untyped one mean something.

The gap is not a usage and must not be counted as one: nothing in the source says the
`any` receiver is a `Client`. It is also not nothing — the call matches the seed's name,
and a reader deserves to know a possible caller exists that the compiler cannot confirm.

## Current behaviour, and why this one is catching a real miss

Probed, zero diagnostics:

- The typed call reports `invoke`/`exact`.
- The untyped call is **unexplained**: `an identifier that resolves to nothing and no gap
reports it`.

That message is the differential check naming precisely what is missing — a reference it
can see, that discovery neither reported nor gapped. Unlike the two dispatch fixtures,
this one is pinning a genuine silent-miss candidate rather than an absent annotation, and
the harness already says so.

## Note on `expression`

The record asserts `expression: "client.send"`, which §10.1 lists as a gap field. A reader
scanning untyped calls needs the text to know what was called; the file and line alone
would make two different untyped calls on one line indistinguishable.
