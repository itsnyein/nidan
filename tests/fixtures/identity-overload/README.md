# identity-overload

**Proves:** overload signatures and their implementation are one logical callable, and the
signature is not part of the structural key.

`parse` gains a third overload and a widened implementation signature. Key:

```
src/parse.ts :: :: function :: parse
```

Because the signature is excluded, this is a **modification** — so the caller in
`use.ts` is still reported. The alternative reading, where a signature change means
delete-plus-add, would lose exactly the usage report a signature change most needs.

Three overload declarations plus one implementation must collapse to a single seed. Four
seeds, or one seed per declaration, both fail this case.
