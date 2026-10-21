# seed-boundary-insert-between

**Proves:** a zero-count diff range is a _position between two lines_, not a span. It
belongs to a callable only when **both** adjacent lines lie inside that same callable's
range; here they do not, so the hunk is an `unmapped-change` gap.

`export const SCALE = 10;` is inserted between `first` and `second`. Neither function's
own text changes.

**Why the input has this shape.** The statement is inserted into the blank line _between_
the two functions, so Git emits a single hunk whose base side is zero-count
(`@@ -4,0 +5,2 @@`). The two lines adjacent to that position are the blank line after
`first` and the opening line of `second` — they lie in _different_ scopes, which is
exactly the condition the rule turns on. Inserting anywhere inside either function body
would put both adjacent lines in one callable and test the opposite case.

**What this caught.** Reading the zero-count range as touching the lines on both sides
attributed the hunk to `second`, whose text had not changed — so the change was filtered
as formatting and produced **no seed and no gap**, while hunk accounting still balanced.
A real insertion disappeared from the report. The report-level expectation here is what
makes that visible: a silent miss shows up as an empty report, not as a passing assertion.
