# ADR-0014: Every reference has a named destination

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

A reference that nidan finds has to end up somewhere. Three destinations were already
defined: a **usage**, a **filtered** non-usage carrying the reason it was filtered, or a
**gap** saying what could not be resolved. Together they underwrite the core guarantee —
no reference within the supported patterns disappears without the report saying so.

While a class's `extends` clause was still being ruled on, a fourth destination was added:
an `undecided` bucket holding references whose correct treatment nobody had decided yet.
It was the honest move at the time. A subclass with no explicit constructor has no
`super()` call in source, so filtering its heritage clause would have left the
construction reported by nothing, and inventing a usage would have pre-empted a decision
that belonged to the maintainer. The bucket made "we have not decided" visible instead of
guessing.

The clause was then ruled on: a subclass with no constructor reports its clause as an
implicit `construct` usage, and one with a constructor keeps the filtered clause while its
`super()` carries the usage. The bucket emptied. Nothing else was ever routed to it, and
nothing was queued to be.

## Decision

Remove the `undecided` bucket. A reference is a usage, a filtered non-usage with a named
reason, or a gap — and nothing else. When a new shape has no ruling, it goes to the
maintainer as a question, carried by a fixture that states the current behaviour, rather
than to a bucket in the output.

## Consequences

An unnamed destination is the one place a reference can go missing while every count still
balances. "Filtered" always says _why_; a gap always says _what could not be resolved_;
`undecided` said only that something arrived. The differential check could not test it
either: a reference landing there was accounted for by definition, so it could never be
`unexplained`. That is precisely the shape of the silent misses this project has paid for
repeatedly, and keeping an empty bucket keeps the shape available.

The cost is real. Keeping it would have been convenient the next time a shape has no
ruling — there would be somewhere safe to put it with the suite staying green. That
convenience is what is being given up, deliberately: an unruled shape now blocks on a
decision instead of accumulating quietly in a bucket nobody reads. Work stops sooner and
more visibly, which is the intended trade.

This binds future rulings. Adding a fourth destination later means revisiting this record,
not quietly extending the type.

## Alternatives considered

**Keep the bucket for the next unruled shape.** Rejected because an empty destination is
not free: it is untestable by the differential check, and the next shape would land in it
by default rather than by decision. The thing that made the bucket safe was the fixture
and the open question attached to it, not the bucket.

**Fold `undecided` into `filtered` with reason `undecided`.** Rejected because it makes
the reason field lie. Every other reason names a rule the reference matched; this one
would name the absence of a rule, and a reader scanning filter reasons would have no way
to tell "this was deliberately excluded" from "nobody has decided yet".

**Fold it into gaps.** Rejected because a gap asserts something specific — a reference
exists that could not be resolved. An unruled shape is usually resolved perfectly well;
what is missing is the decision about how to classify it. Reporting it as a gap would
overstate what nidan failed to do and would pollute the gap counts that the no-silent-miss
guarantee is measured against.
