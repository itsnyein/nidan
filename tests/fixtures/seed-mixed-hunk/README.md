# seed-mixed-hunk

**Proves:** a hunk that changes a callable **and** text outside every covered callable
produces **both** the seed and an `unmapped-change` gap for the uncovered line. The hunk
is counted once, as seed-consumed.

`LIMIT` changes on line 1 and `total`'s signature on line 2.

**Why the input has this shape.** The two edits must be on **adjacent** lines. Under the
pinned `--unified=0 --inter-hunk-context=0` Git emits a single hunk for them
(`@@ -1,2 +1,2 @@`, verified); separate them by even one unchanged line and Git emits two
hunks, the top-level change becomes a gap on its own, and the expectation passes without
the ruling being implemented at all. My first attempt at this fixture made exactly that
mistake — `LIMIT` on line 1 and the function _body_ on line 3 produced `@@ -1 +1 @@` plus
`@@ -3 +3 @@`.

The changed line inside the callable is its **signature**, not its body, because the
signature is the line adjacent to the top-level statement. Changing `readonly` into the
parameter type is a real token-signature change, so `total` is genuinely `modified` rather
than formatting-only.

**Why there is one gap, not two.** `LIMIT` is uncovered on **both** snapshots — it
changed in base and in head, and no callable contains it either way. Only the head gap is
reported, because the base line is the **replaced counterpart** of the uncovered head
line: Git lists a hunk's two sides in parallel, so the base line at offset `n` was
replaced by the head line at offset `n`. One edit, one gap (§8.2 as ruled 2026-10-21).

A base line _without_ a counterpart — one whose offset falls beyond the head range, which
means deleted text — is never carried by a head gap and always gets its own. That is the
case this rule exists to protect: a statement deleted beside a modified callable has
uncovered base lines and no head counterpart, so reporting head-side runs only would leave
it named by nothing. See the `seeds-attribution` test "reports the deletion on the base
side, not only the head edit".

This fixture's expectation is therefore **unchanged** from what E2d froze. An intermediate
ruling briefly required a gap per side, which would have made it two; that wording was
corrected because it named every modification twice.

**What this caught.** `mapSeeds` tested its seed-consumed branch first, so a hunk
attributed to a seeded callable was counted as fully consumed whatever else it changed.
The `LIMIT` edit got neither a seed nor a gap while hunk accounting still balanced — the
third M2 silent miss, one layer out from the two T2.4 fixed. T2.5 replaces hunk-level
accounting with a line-level invariant so the whole class is closed rather than this
instance.
