# usage-commonjs-exports

**Proves:** the three supported CommonJS export spellings (§6.3) are **module patterns,
not usages**, and the calls through the required namespace are what count.

```
src/lib.js :: :: function :: alpha
src/lib.js :: :: function :: bravo
src/lib.js :: :: function :: charlie
```

| Site                                            | Expected                    |
| ----------------------------------------------- | --------------------------- |
| `src/lib.js` line 13 — `module.exports.alpha =` | filtered `export-specifier` |
| `src/lib.js` line 14 — `exports.bravo =`        | filtered `export-specifier` |
| `src/lib.js` line 15 — `module.exports.pack =`  | filtered `export-specifier` |
| `src/use.js` line 4 — three calls through `lib` | three `invoke`, `exact`     |

## Why this shape

Three seeds, one per export spelling, and all three called from **one line** of one
function. `from` is therefore identical for all three, so the only thing distinguishing
them in the record is which seed the usage belongs to — which is exactly what a module
pattern has to get right.

## The ruling this fixture asks for

**Are CommonJS exports filtered, or are they value references?**

This record says **filtered**, by analogy with ESM: §9 filters import and export
specifiers, and §6.3 lists these three spellings as _module patterns_ rather than as uses
of a callable. `module.exports.alpha = alpha` is how the module says "this is my public
name for `alpha`", which is what `export { alpha }` says in ESM.

The analyser currently disagrees, and it is not obviously wrong to: probed before this
record was written, it reports `module.exports.alpha = alpha` and `exports.bravo = bravo`
as **`value-reference`** usages, because the right-hand side genuinely is the callable used
as a value. Both readings are defensible, which is why this is a Gate 2 question rather
than an implementation detail.

The practical difference: under the filtered reading a reader sees one usage per call
site; under the value-reference reading every exported callable carries an extra entry
pointing at its own export line, in every CommonJS file in the repository.

## Current behaviour

Probed, zero diagnostics:

- `alpha` and `bravo` report a `value-reference` at their export lines (13, 14).
- `charlie` reports nothing — its shorthand inside `module.exports.pack = { charlie }` is
  filtered as a `declaration`.
- **Four unexplained occurrences**, including all three calls on `src/use.js` line 4.

So the three spellings are not merely unimplemented — they are currently treated three
different ways. A pending entry asserts that exactly.
