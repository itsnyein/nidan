# identity-re-export

**Proves:** a barrel re-export resolves to the original symbol rather than creating a
second identity.

`format.ts` declares `formatRow`, `index.ts` re-exports it, `consumer.ts` imports from the
barrel. Only `format.ts` changes. One seed:

```
src/format.ts :: :: function :: formatRow
```

**One usage, not two.** A re-export that produced its own symbol would report the usage
once through the barrel and once directly, and the duplicate would be indistinguishable
from a real second caller.

The re-export statement in `index.ts` is an export specifier, which is filtered — it is a
reference to the symbol but not a usage of it.
