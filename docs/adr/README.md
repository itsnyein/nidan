# Architecture decision records

Each record states what was decided, why, and what it costs. A record is written when a
decision would otherwise survive only as unexplained code — a constraint someone later
would be tempted to "fix" without knowing what it was protecting.

Records are immutable once accepted. A decision that changes gets a new record that
supersedes the old one; the old one stays, because the reasoning that led to it is part of
the history.

Use [`template.md`](template.md) for new records. Number them sequentially.

| #                                                    | Decision                                                     | Status   |
| ---------------------------------------------------- | ------------------------------------------------------------ | -------- |
| [0001](0001-ts-morph-as-the-analysis-engine.md)      | ts-morph as the analysis engine                              | Accepted |
| [0002](0002-structural-key-identity-model.md)        | Structural keys for callable identity                        | Accepted |
| [0003](0003-relation-and-resolution-are-separate.md) | Relation and resolution are separate fields                  | Accepted |
| [0004](0004-gaps-not-edges.md)                       | Uncertainty is reported as a gap, never as an edge           | Accepted |
| [0005](0005-snapshot-semantics.md)                   | Sources from Git objects, dependencies from the working tree | Accepted |
| [0006](0006-correctness-before-performance.md)       | Correctness before performance, with a measured baseline     | Accepted |
| [0007](0007-typescript-version-policy.md)            | Two TypeScript versions, with only one governing results     | Accepted |
| [0008](0008-documentation-status-markers.md)         | Documentation status markers                                 | Accepted |
| [0009](0009-versioning-contracts.md)                 | Three independent versioning contracts                       | Accepted |
| [0010](0010-prettier-formats-governance-markdown.md) | Prettier formats governance Markdown                         | Accepted |
| [0011](0011-repo-local-noreply-commit-email.md)      | Repository-local noreply commit email                        | Accepted |
| [0012](0012-tests-helpers-directory.md)              | `tests/helpers/` for test-only helpers                       | Accepted |

Records 0001–0006 are the set required before Phase 1 can be called done. They cover the
engine, the identity model, the relation/resolution split, gaps-not-edges, snapshot
semantics, and the performance policy.
