# overlay-basic

**Proves:** each snapshot is served from its own Git objects, and a modified callable is
reported with its direct caller.

`src/format.ts` changes between base and head; `src/main.ts` is identical in both and
calls `formatRow`.

If the two snapshots were not isolated — if head content leaked into the base program, or
one program served both refs — `formatRow` would compare equal and produce no seed. A
result here therefore depends on the overlay actually being per-ref.

The usage is `invoke` with `exact` resolution: `main.ts` calls `formatRow` through a
relative ESM import.

One deliberate subtlety: the call sits inside `rows.map((row) => formatRow(row))`. That
arrow function is an anonymous callback, which is **not** a supported callable, so it
cannot be the `from`. The attribution rule says `from` is the nearest enclosing
_supported_ callable — `render`. An implementation that reported the arrow, or fell
through to the module node, would fail this case.
