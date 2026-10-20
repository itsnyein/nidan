# ADR-0009: Three independent versioning contracts

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

omen has three public surfaces that change for different reasons and at different rates:
the CLI, the JSON report, and the human-readable text output.

Tying them to one version number forces false coupling. A bug fix would imply a schema
change; a schema addition would imply a CLI change. Consumers could not tell which
surface actually moved.

Text output is the sharpest case. It must be free to improve — wording, layout, ordering
for readability — but any consumer that parses it will break when it does.

## Decision

Three contracts, versioned independently.

**Package version.** 0.x SemVer. While in 0.x, a breaking change to the CLI or the schema
is a minor bump and a fix is a patch.

**`schemaVersion`.** Carried in every JSON report and versioned on its own. It does not
track the package version, and neither implies the other.

**Text output: not a contract.** Explicitly unstable, and documented as such. Automation
must read JSON.

Public contract is the CLI flags and arguments, the exit codes, the JSON schema, and the
documented supported patterns and limitations. Changing any of them is a breaking change
requiring explicit approval.

Within the schema, stability is per field: `resolution.status` is stable while
`resolution.mechanism` is experimental — see
[ADR-0003](0003-relation-and-resolution-are-separate.md).

## Consequences

- A consumer pins behavior against `schemaVersion` and is unaffected by package releases
  that do not touch the report.
- Text output can be improved freely, which keeps the human-facing format from ossifying.
- Experimental fields can ship and be withdrawn without a breaking change, provided they
  are marked.
- Two version numbers must be maintained and reasoned about, and a contributor must know
  which surface a change touches. That cost is the point: the question is forced at review
  time.
- Someone will parse the text output anyway. The documented stance is what makes that
  their decision rather than a broken promise.

## Alternatives considered

**One version for everything.** Simplest to explain. Rejected because it makes the version
number uninformative: a consumer cannot tell a schema change from a CLI fix, so every bump
has to be treated as potentially breaking.

**Make text output a contract too.** Honest in a different way, and friendlier to shell
pipelines. Rejected because it would freeze the human format permanently, and the JSON
output already serves every machine consumer.

**Start at 1.0 for the schema.** Rejected as premature: the schema is frozen in T5.2 after
the analysis work that will shape it, and claiming stability before then would be a
promise made without evidence.
