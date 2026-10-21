# seed-boundary-insert-body-first

**Proves:** the positive half of the boundary rule. When **both** lines adjacent to a
zero-count range lie inside the same callable, the hunk belongs to that callable and
seeds it.

`values.push(0);` is inserted as the first statement of `record`.

**Why the input has this shape.** It is a _pure_ insertion: no existing line is modified,
so the base side really is zero-count (`@@ -1,0 +2 @@`). An insertion that also rewrites
a neighbouring line produces a hunk with real lines on both sides, which never reaches
the zero-count branch and so would not test this rule at all. The insertion point is
immediately after the opening brace, so the adjacent lines are the declaration line and
the first body line — both inside `record`.

**Why it is in this set.** Without it, a fix that returned an `unmapped-change` gap for
_every_ zero-count range would satisfy the two between-function fixtures while silently
destroying ordinary insertions. This case and `seed-boundary-insert-body-last` are what
make the rule a rule rather than a blanket.
