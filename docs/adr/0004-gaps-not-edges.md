# ADR-0004: Uncertainty is reported as a gap, never as an edge

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Static analysis of JavaScript and TypeScript runs out of evidence constantly: a dynamic
`import(expr)`, a `require` behind an alias, a method call on an `any`, a module specifier
that will not resolve, an interface method with four implementations.

At each of those points a tool can do one of three things: guess an edge, drop the
occurrence silently, or record that it could not tell.

Guessing is attractive because it makes output look complete. It is also what makes impact
tools untrustworthy — a user who finds one invented caller stops believing the rest.
Dropping silently is worse: it is indistinguishable from "there is nothing here", and it
breaks the core guarantee outright.

## Decision

omen never emits an edge it cannot support with compiler evidence. Anything that cannot be
statically confirmed becomes an **`AnalysisGap`**: a typed record of what could not be
determined, where, and why.

A gap is explicitly **not** an edge. Gaps live in their own part of the report and are
never counted as usages. Gaps attributable to a seed appear under it; the rest are
aggregated as repository-wide gaps.

This is what makes the core guarantee checkable: every occurrence of a changed symbol is a
reported usage, a filtered non-usage, or a reported gap — see
[ADR-0006](0006-correctness-before-performance.md) for how that is enforced in testing.

## Consequences

- Every usage in the report is backed by evidence. A user can trust what is there.
- The report is honest about what it does not know, and the gap count is a first-class
  signal rather than a footnote.
- Zero usages plus a nonzero gap count is meaningful and legible — which is why the
  zero-result wording is "No static usages found" and never "No impact".
- Output is noisier than a tool that guesses. A codebase with heavy dynamic wiring will
  produce many gaps, and that is the correct report, not a defect.
- Every new limitation needs a gap kind, a site, and a reason code. That is ongoing work
  and deliberately so: adding a limitation without a gap kind would reintroduce silent
  dropping.
- Each gap kind needs its own fixture proving it fires where expected.

## Alternatives considered

**Emit a low-confidence edge.** Keeps everything in one list and looks more complete.
Rejected: it puts invented relationships next to real ones and makes the whole report only
as trustworthy as its weakest entry. Confidence about _which symbol_ is already handled by
`resolution` — see [ADR-0003](0003-relation-and-resolution-are-separate.md) — and that is
a different question from "could not analyze this at all".

**Drop what cannot be resolved.** Produces the cleanest-looking output. Rejected outright:
it is the one behavior that makes an empty result actively misleading, and it would make
the core guarantee unverifiable.

**A diagnostics log instead of structured gaps.** Rejected because a log is not
machine-readable and cannot be asserted in a fixture. Gaps are part of the public JSON
contract precisely so they can be tested and consumed.
