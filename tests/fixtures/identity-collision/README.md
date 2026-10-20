# identity-collision

**Proves:** a duplicate structural key within one snapshot is not matched, and reports an
`ambiguous-identity` gap.

`dup.js` declares `handle` twice at the same container level. This is legal JavaScript —
the later declaration wins at runtime — and the two share a key exactly, because the
signature is not part of it:

```
src/dup.js :: :: function :: handle
```

The expectation is **no seed and one gap**. Picking either declaration would be a guess,
and a guessed identity produces a report about the wrong code, which is worse than
reporting that omen could not tell.

JavaScript rather than TypeScript deliberately: TypeScript rejects the redeclaration, so
the collision would never reach identity matching.
