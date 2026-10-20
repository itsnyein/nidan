# identity-default-exports

**Proves:** all three default-export forms key correctly, in one place where they can be
compared.

| File                   | Form                                             | Key                                                  |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `named-default.ts`     | `export default function formatLabel()`          | `src/named-default.ts :: :: function :: formatLabel` |
| `anonymous-default.ts` | `export default function ()`                     | `src/anonymous-default.ts :: :: function :: default` |
| `aliased-default.ts`   | `function toSlug()` then `export default toSlug` | `src/aliased-default.ts :: :: function :: toSlug`    |

The third is the one worth stating: `export default foo` is an **alias**, not a
declaration, so the identity stays `toSlug`. Keying it as `default` would make a later
rename of the local function look like a delete plus an add.

Seeds are listed in key order, which is also the order the report sorts them in.
