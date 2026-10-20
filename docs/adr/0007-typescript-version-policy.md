# ADR-0007: Two TypeScript versions, with only one governing results

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Two different TypeScript versions are present in this project, and conflating them would
be a real source of confusion.

- **The analysis TypeScript** is the copy bundled inside ts-morph. It is what parses and
  type-checks the repository under analysis, so it determines what omen reports.
- **The development TypeScript** is the `typescript` devDependency, used to typecheck and
  lint omen's own source. It has no effect on any result.

They already differ. At the time of writing, ts-morph 28.0.0 bundles TypeScript 6.0.2 and
the development dependency is 6.0.3.

There is a second constraint: the newest TypeScript cannot always be used. TypeScript 7.0
was rejected for development because `typescript-eslint` declares support for
`>=4.8.4 <6.1.0` and aborts at load against the 7.x API.

## Decision

**The bundled version governs analysis.** It is reported in the output, because results
depend on it. ts-morph is pinned to an exact version so that this cannot change silently —
see [ADR-0001](0001-ts-morph-as-the-analysis-engine.md).

**The development version is independent** and may differ. It is selected by what the lint
and typecheck toolchain supports, following the project's standing version policy: newest
stable release published at least 14 days ago, falling back to the newest compatible
release when something declares incompatibility, with the evidence recorded.

**The TypeScript 7 native port is reviewed before any ts-morph upgrade**, not alongside
it. It is a reimplementation, so its effect on analysis output is a question in its own
right.

## Consequences

- "Which TypeScript produced this result?" has one answer, and it is in the report.
- Upgrading the analysis compiler is an explicit ts-morph upgrade, reviewable as a change
  that can move output.
- The two versions drifting apart is normal and not a defect to chase.
- Development tooling can lag the newest TypeScript without holding back analysis, and
  vice versa.
- omen cannot analyze code using syntax newer than the bundled compiler understands, no
  matter what the development dependency is.
- A ts-morph upgrade needs the full fixture suite as its regression check, since output
  may legitimately change.

## Alternatives considered

**Force both to the same version via an override or a peer dependency.** Appealing for
tidiness. Rejected because it couples two unrelated constraints: it would let a linter's
supported range dictate the analysis compiler, which is backwards.

**Use the project-under-analysis's own TypeScript from its `node_modules`.** Arguably the
most faithful, since it is the compiler that project actually uses. Rejected for Phase 1:
results would vary by target repository, determinism across machines would weaken, and
omen would be loading and executing a compiler chosen by the analyzed repository — a
meaningful change to the security boundary.

**Pin only the development version and float ts-morph.** Rejected: it is exactly backwards.
The floating one would be the version that changes results.
