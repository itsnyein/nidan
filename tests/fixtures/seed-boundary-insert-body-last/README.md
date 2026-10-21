# seed-boundary-insert-body-last

**Proves:** the boundary rule holds at the _closing_ edge of a body, where one adjacent
line is the function's own closing brace.

`values.push(2);` is inserted after the last statement of `record`.

**Why the input has this shape.** A pure insertion again (`@@ -2,0 +3 @@`), placed
between the final statement and `}`. This is the case most likely to be got wrong by an
off-by-one: the closing brace is the callable's **last** line, so a span that ended one
line early would put the insertion point outside the function and produce a spurious gap.
`record` returns `void` and its last statement is an expression, so a statement can be
appended without becoming unreachable — appending after a `return` would be dead code and
would not represent a change anyone makes.

Paired with `seed-boundary-insert-body-first`, this pins both edges of the body.
