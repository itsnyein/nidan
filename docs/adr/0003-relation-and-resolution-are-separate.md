# ADR-0003: Relation and resolution are separate fields

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

A reported usage answers two different questions, and early sketches conflated them into
a single enum with values such as `invoke` and `maybe-invoke`.

The questions are independent:

1. **What is the code doing?** Calling, constructing, rendering as JSX, or passing the
   callable around as a value.
2. **How sure is nidan that this is the right symbol?** The reference resolved directly, or
   it resolved to a group of related symbols such as an interface member and its
   implementations.

Conflating them multiplies the vocabulary — every relation needs a certain and an
uncertain variant — and makes both halves harder to consume.

## Decision

A usage carries two independent fields.

**Relation** is syntactic: `invoke`, `construct`, `jsx-render`, or `value-reference`.

**Resolution** is evidential: `exact` when the reference resolves directly to the seed
symbol, `ambiguous` when it resolves to a related-symbol group or to more than one
candidate, with the candidates listed.

Within the resolution object, `resolution.status` is stable public contract while
`resolution.mechanism` is marked experimental, so how nidan arrived at an answer can change
without a breaking change.

## Consequences

- The vocabulary stays small and each value means one thing.
- A consumer filters on whichever axis it cares about. "Show me every construction" and
  "show me only certain matches" are separate filters that compose.
- Confidence can improve over time without renaming relations. If a later phase resolves
  dispatch, an `ambiguous` usage becomes `exact` and the relation is untouched.
- Two fields must both be read to interpret a usage. A consumer that reads only the
  relation will treat uncertain matches as certain — which is why `status` is stable
  contract and prominent in the output.
- Uncertainty that is not about _which symbol_ still belongs in a gap, not here. Dispatch
  that cannot be resolved produces an `interface-or-override-dispatch` gap — see
  [ADR-0004](0004-gaps-not-edges.md).

## Alternatives considered

**One enum with certainty baked in** (`invoke`, `maybe-invoke`, `construct`,
`maybe-construct`, …). Rejected: the value count doubles, filtering on either axis means
matching a list of names, and adding a third relation adds two values.

**A numeric confidence score.** Rejected because nidan reports compiler evidence, not
estimates. There is no principled way to say 0.7, and a score invites consumers to invent
thresholds nidan cannot justify.

**Resolution as a boolean `exact: true | false`.** Close, and simpler. Rejected because
`ambiguous` needs to carry the candidate list — a boolean has nowhere to put it.
