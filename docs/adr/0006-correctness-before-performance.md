# ADR-0006: Correctness before performance, with a measured baseline

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Loading two fully type-checked programs is the expensive part of nidan by a wide margin,
and the obvious optimizations are available from the start: load the base snapshot lazily,
skip type information where it seems unnecessary, cache aggressively between runs, or
build a reference index instead of querying per seed.

Every one of those trades evidence for speed. A lazily loaded program answers differently
from a fully loaded one at the edges — and the edges are where nidan's guarantee lives.

The pull to optimize early is strongest before any measurement exists, which is exactly
when there is no way to tell whether the cost is real.

## Decision

Correctness comes first. Both snapshots are loaded as complete, type-checked programs.
Reference discovery is driven per changed symbol rather than by building a whole-program
graph.

**No performance budget is set for Phase 1.** A baseline is measured and published
instead: program load time, per-seed query time, and peak memory, measured separately
against pinned open-source repositories.

Optimization requires a measurement showing the need. Budgets and regression thresholds
are set only once the baseline exists.

## Consequences

- Results are the best the compiler can give, with no caveat about which optimization was
  active.
- Early runs are slower than they could be, and memory use on large repositories is
  untuned. This is accepted, not unnoticed.
- The baseline makes later optimization arguable from data: a change can be shown to help,
  and a regression can be shown to be one.
- A whole-program reverse graph is deferred to Phase 2, where transitive analysis makes it
  necessary. Phase 1 does not pay for infrastructure it does not use.
- Some optimizations get harder to adopt later, because fixtures will have been written
  against full-program behavior. That is the intended ratchet: a change that alters results
  should be hard.

## Alternatives considered

**Lazy base loading now.** The largest single win, since the base snapshot is only needed
for seeds and deleted-callable usages. Rejected until measured: it changes what the
checker can resolve, so it must be evaluated as a correctness change, not a speed knob.

**A performance budget from the start.** Rejected as guesswork. A budget invented without
data either passes trivially or fails arbitrarily, and in both cases it teaches nothing.

**Whole-program reference index.** Likely faster once many seeds are involved, and
required eventually for transitive analysis. Rejected for Phase 1 because it is
infrastructure for a feature that does not exist yet.
