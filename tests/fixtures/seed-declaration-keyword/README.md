# seed-declaration-keyword

**Proves:** the declaration keyword (`let` / `const` / `var`) is part of **every**
declarator's token signature, so changing it is a modification of every callable the
statement declares (§8.1 as amended 2026-10-21).

`let a = () => 1, b = () => 2;` becomes `var a = …, b = …;`. Both `a` and `b` are seeded
`modified`.

**Why the input has this shape.** Two declarators in **one** statement, so the keyword is
shared. With a single declarator the statement is already the signature source and the
keyword is included — the defect existed only in the multi-declarator case, which made the
behaviour internally inconsistent as well as wrong.

The declarators are split across lines so the diff is a single hunk touching only the
keyword line; the initializers are untouched, so nothing else can account for a seed.

**Why this is substantive, not formatting.** `let` → `var` changes scoping and TDZ
semantics for both callables: `var` hoists and is function-scoped, `let` is block-scoped
and unreachable before its declaration. §8.1's exemption list is closed — whitespace and a
trailing comma before a closing bracket — and a keyword is neither.

**What this caught.** `enclosingStatement` returns the _declarator_ for a multi-declarator
statement, so siblings keep distinct spans. That put the shared keyword outside every
declarator's signature: both compared equal and the change was filtered as formatting —
**no seed, no gap**. Found by the M2 milestone review.

Sibling independence for _initializer_ edits is unaffected: shared tokens differ only when
the shared tokens themselves change, which is exactly when all declarators should be
modified. `seeds-attribution` covers the initializer-only case.
