# seed-overload-hull-gap

**Proves:** an overload set owns **each declaration's own range**, never the hull from the
first signature to the last. A line between two signatures belongs to no callable and
produces an `unmapped-change` gap (§7.2 as amended 2026-10-21).

`LIMIT` changes on line 2, between the two `declare function f` signatures.

**Why the input has this shape.** Ambient `declare function` overloads need **not** be
contiguous — only _implementation_ overloads must be. So a top-level statement can legally
sit between two signatures, with zero compiler diagnostics, inside a supported pattern.
A contiguous implementation overload set cannot express this case at all.

The changed line is `export const LIMIT = 2;`, not a comment or whitespace, so there is no
reading under which the hunk is formatting-only.

**What this caught.** `declarationsOf` collapsed the overload set into one callable whose
span ran first-signature-to-last, so line 2 was "inside" `f`. `f`'s own tokens were
unchanged, so it compared equal, and the line was filtered as formatting: **no seed, no
gap**, with the hunk counted as `formattingFiltered: 1`. Found by the M2 milestone review.

It also showed that the line-coverage invariant's `formatting` corroboration was
satisfiable by a substantive change: "inside a formatting-equal callable's line range"
admits ranges that contain non-callable text.
