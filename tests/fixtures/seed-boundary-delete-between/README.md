# seed-boundary-delete-between

**Proves:** the deletion half of the boundary rule. A top-level statement removed from
between two functions is an `unmapped-change` gap, not a change to either neighbour.

`export const SCALE = 10;` is deleted from between `first` and `second`.

**Why the input has this shape.** This is the mirror of `seed-boundary-insert-between`:
the _head_ side is the zero-count one (`@@ -5,2 +4,0 @@`), so it exercises the rule from
the other direction. Both cases are needed because the two sides are handled by separate
branches — a fix that corrected only insertions would pass the other fixture.

The gap is reported against **base**, the snapshot that still holds the deleted text.
Reporting it against head would name a line that does not contain the removed code.

**What this caught.** The same silent miss as the insertion case, reached through the
head range rather than the base range.
