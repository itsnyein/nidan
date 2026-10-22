# ADR-0002: Structural keys for callable identity

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Classifying a callable as added, deleted, or modified means matching declarations across
two snapshots. The two snapshots are separate compiler programs, so a symbol from `base`
and a symbol from `head` are different objects with no shared identity — they must be
matched by a key nidan computes.

The key decides correctness of the whole diff stage. Too strict, and an ordinary edit
looks like a delete plus an add, producing noise and losing the usage report that matters.
Too loose, and two different callables are matched, producing a report about the wrong
code.

## Decision

Each callable gets a structural key:

```text
relativePosixPath :: containerChain :: declarationKind :: name [:: static]
```

`containerChain` holds the enclosing classes and callables, which distinguishes nested
functions sharing a name. The signature is deliberately **not** part of the key.

When the same key appears twice within one snapshot, nidan does not match. It emits an
`ambiguous-identity` gap, per [ADR-0004](0004-gaps-not-edges.md).

## Consequences

- Changing a parameter, a return type, or an overload is a **modification**, so usages are
  still reported. This is the common case and the one that matters most.
- Identity is computed from structure alone, so it needs no heuristics, no content
  hashing, and no similarity threshold. It is cheap and explainable.
- A file move or rename **breaks the match**: every callable appears as deleted at the old
  path and added at the new one. This is a documented limitation, not a bug to work around
  with rename detection in Phase 1.
- Renaming a callable in place is likewise a delete plus an add.
- A key collision degrades to a reported gap rather than a wrong match. The failure mode is
  loud.
- Keys are repository-relative and POSIX, so they are stable across machines and feed
  directly into deterministic output ordering.

## Alternatives considered

**Include the signature in the key.** Makes collisions less likely. Rejected because it
inverts the common case: changing a signature is precisely when you most want to see who
calls the function, and this would report it as an unrelated delete and add.

**Content hashing or similarity matching to detect moves.** Would survive renames and
moves. Rejected for Phase 1: it introduces a threshold, and a threshold produces matches
that cannot be explained from compiler evidence. A wrong match is worse than a declared
limitation, because it is silent.

**The compiler's own symbol identity.** The natural choice within one program, and it is
what nidan uses _inside_ a snapshot. Rejected for cross-snapshot matching because the two
programs share nothing — there is no object to compare.
