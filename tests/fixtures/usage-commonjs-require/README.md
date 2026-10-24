# usage-commonjs-require

**Proves:** the three supported `require` spellings (§6.3) reach the same seed, and the
one that imports rather than calls is filtered.

```
src/greet.js :: :: function :: greet
```

| Site                                           | Expected                    |
| ---------------------------------------------- | --------------------------- |
| `src/use.js` line 2 — `const { greet } = ...`  | filtered `import-specifier` |
| `src/use.js` line 5 — `mod.greet()`            | `invoke`, `exact`           |
| `src/use.js` line 9 — `greet()`                | `invoke`, `exact`           |
| `src/bare.js` line 1 — `require("./greet.js")` | nothing; it binds no name   |

## Why this shape

All three spellings in one file, against one seed, because they differ only in **how the
name arrives**: through a namespace object, through destructuring, or not at all. The seed
and the call are otherwise identical, so a difference in the report is a difference in
module handling and nothing else.

`src/bare.js` is a deliberate negative. `require("./greet.js")` for its side effects binds
no name, so there is no reference to report — and a reader should be able to tell that
apart from a reference that was _missed_.

**The destructured form is an import, not a usage.** `const { greet } = require(...)`
is the CommonJS spelling of `import { greet }`, which §9 filters as an import specifier.
Reporting it as a usage would count the import and the call as two call sites.

## Current behaviour, and why this fixture is not green yet

CommonJS is unimplemented. Probed before this record was written:

- **no usages at all**, and
- **three unexplained occurrences** — lines 2, 5 and 9, each
  `resolves to the seed but discovery neither reported nor filtered it`.

That second line is the point worth noting: the misses are **not silent**. The
differential check already reports them, which is the no-silent-miss guarantee doing its
job on a feature that does not exist yet. A pending entry asserts exactly this, so the
fixture cannot quietly start passing for the wrong reason.
