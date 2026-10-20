# ADR-0008: Documentation status markers

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

T0.3a published the full Phase 1 behavior documentation before any of it was implemented.
That is the right order — the fixture harness and every later task are written against
documented behavior rather than the reverse — but it creates a document set that describes
a tool which does not yet do these things.

A reader has no way to tell specification from shipped behavior. The risk is not
theoretical: documented supported patterns and limitations are public contract, so a user
could reasonably build on a page describing unimplemented behavior.

## Decision

Every document in `docs/` that describes unimplemented behavior opens with a single line
directly under its title:

```markdown
> **Status: specified, not yet implemented.**
```

`docs/README.md` explains the marker once and states the rule: the task that implements an
area removes the line from the matching document, and a document without the line
describes behavior you can rely on from the version that ships it.

Removal is **enforced by review**, not mechanically. Each implementing task's prompt makes
removing the marker an acceptance criterion for the area it covers.

## Consequences

- A reader can tell at a glance whether a page describes a promise or a fact.
- The marker's disappearance is a visible event in a diff, so it is reviewable.
- The marker is only as honest as the discipline removing it. A document whose behavior
  ships while the line stays is actively misleading — worse than no marker, because it
  understates what works.
- Partial implementation is awkward: a page is marked or not, with no middle state. A
  document covering an area implemented across several tasks keeps its marker until the
  last one lands, understating progress in between.

## Alternatives considered

**Enforce removal with a test.** A test could fail when a marker outlives its implementing
task. Rejected for now because the mapping from document to "its task" has to be written
down somewhere and kept current — a second thing to maintain, which can rot in the same
way. Worth revisiting if a marker is ever found surviving a merge; that would be evidence
review is not sufficient.

**Do not publish until implemented.** Removes the problem entirely. Rejected because it
inverts the dependency: the fixture harness and the `E` tasks need written behavior to
work against, and `decisions.md` places the behavior documentation before them
deliberately.

**Amendment (2026-10-20):** a document implemented apart from one named part may narrow
its marker to a single clause stating the exception, rather than carrying the blanket
marker or dropping it. `docs/cli.md` is the first case — its flags and exit codes became
contract in T1.4 while one `degraded` reason still waits on seed mapping. The blanket
marker would have understated a published contract; removing it would have overclaimed.
One clause is not the per-section marking rejected below: it names a single exception in
the document's own status line.

**A per-section marker rather than per-document.** More precise for partially implemented
pages. Rejected as too noisy — a page with a marker on every other heading is harder to
read than the thing it clarifies.

**Keep the caveat in `planning/` only.** Rejected: `planning/` is Git-ignored, so the
readers who need the warning are exactly the ones who cannot see it.
