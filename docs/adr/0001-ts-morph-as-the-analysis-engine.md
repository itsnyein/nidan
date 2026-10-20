# ADR-0001: ts-morph as the analysis engine

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

omen's core guarantee is that within supported static patterns there is no unexplained
reference. Meeting it requires resolving a reference to a declaration using real type
information: resolving aliases and re-exports to their original symbol, treating overload
signatures and their implementation as one callable, and distinguishing a type-only
position from a value position.

That rules out anything without a type checker. A syntax-only parser can find the token
`formatRow`, but cannot say which `formatRow` it means, which is the entire question.

The remaining choice was how to reach the TypeScript compiler: directly through its
Compiler API, or through a wrapper.

## Decision

Analysis runs on **ts-morph**, which wraps the TypeScript Compiler API. Where ts-morph
does not expose what is needed, the underlying compiler API is used behind a narrow
adapter rather than spread through the codebase.

ts-morph is pinned to an exact version, because analysis results depend on the TypeScript
version it bundles — see [ADR-0007](0007-typescript-version-policy.md).

## Consequences

- Reference discovery, symbol resolution, and a virtual file system arrive as supported
  APIs rather than as code omen must write and maintain.
- A `FileSystemHost` seam already exists, which is what makes reading sources from Git
  objects possible — see [ADR-0005](0005-snapshot-semantics.md).
- The TypeScript version used for analysis is chosen by ts-morph, not by omen. Upgrading
  the analysis compiler means upgrading ts-morph.
- A ts-morph release can change analysis output without any change to omen. The exact pin
  makes that a deliberate, reviewable event.
- One of omen's two runtime dependencies. The dependency budget is spent here on purpose.

## Alternatives considered

**The TypeScript Compiler API directly.** Removes the wrapper and its version coupling,
and is the most capable option. Rejected for Phase 1: it would mean writing and testing a
`LanguageServiceHost`, a `CompilerHost`, document registry handling, and reference-search
plumbing before any omen-specific behavior could be built — a large amount of
infrastructure whose bugs would be indistinguishable from analysis bugs. The narrow
adapter keeps this route open where it is actually needed.

**Babel, SWC, or another parser with a resolver bolted on.** Faster and lighter, and
adequate for finding syntax. Rejected because none provides a type checker, so none can
answer which declaration a reference resolves to. Evidence would degrade to name matching,
which is the thing omen exists not to do.

**ESLint's scope analysis.** Real binding information and already in the toolchain.
Rejected because it is file-scoped and lexical: it does not follow a symbol across module
boundaries, re-exports, or barrels, which is where most of the interesting usages are.
