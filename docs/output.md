# Output

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

nidan produces two output formats: `text` for reading, and `json` for machines.

The JSON report is [public contract](README.md#what-is-public-contract). Text output is not — its wording and layout may change in any release, so automation must read JSON.

## JSON structure

The report has these top-level sections:

| Section         | Contents                                                                              |
| --------------- | ------------------------------------------------------------------------------------- |
| `schemaVersion` | The version of the report schema                                                      |
| `run`           | Status, analysis mode, reasons, warnings, and counts                                  |
| `coverage`      | The [coverage statement](limitations.md#coverage-statement)                           |
| `seeds`         | One entry per changed callable, each with its `usages`, `valueReferences`, and `gaps` |
| `repoWideGaps`  | Gaps that could not be attributed to any seed                                         |

The analysis TypeScript version and the resolved commit SHAs that were compared are reported, because results depend on both.

### Field stability

Within the schema, `resolution.status` is **stable**. `resolution.mechanism` is marked **experimental** and may change or disappear without a breaking change.

### Versioning

`schemaVersion` is versioned independently of the package version. A schema change and a package release are not the same event, and neither implies the other.

## Usage kinds

Each usage carries a relation — `invoke`, `construct`, `jsx-render`, or `value-reference` — described in [usage relations](supported-patterns.md#usage-relations). Value references are reported separately from invocations, so a callable merely passed as a value is never presented as a call.

Each usage also carries a resolution status:

| Status      | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `exact`     | The reference resolves directly to the seed symbol                                                             |
| `ambiguous` | The reference resolves to a group of related symbols, or to more than one candidate. The candidates are listed |

Every usage records its origin: the enclosing supported callable, or the [module node](concepts.md#vocabulary) for top-level code.

## Gap kinds

A gap records something static analysis could not confirm. **A gap is never an edge** — nidan reports uncertainty rather than guessing a relationship.

| Kind                             | Condition                                                               |
| -------------------------------- | ----------------------------------------------------------------------- |
| `dynamic-import`                 | `import(expr)` with a non-literal argument                              |
| `dynamic-require`                | `require(expr)` with a non-literal argument, or an aliased `require`    |
| `unresolved-module`              | A module specifier that cannot be resolved                              |
| `interface-or-override-dispatch` | A seed method implements an interface member or overrides a base method |
| `untyped-member-call`            | A member call matching the seed name on an `any` or unresolved receiver |
| `ambiguous-identity`             | The same identity key appears twice in one snapshot                     |
| `unmapped-change`                | A diff hunk that maps to no callable                                    |

Each gap records its `kind`, the `snapshot` it was found in, the `site` as a file and range, the `expression` where one applies, the `relatedSeed` when it can be attributed, and a `reasonCode`.

### Gap scope

Gaps attributable to a seed appear under that seed. Gaps that cannot be attributed appear in `repoWideGaps`, aggregated as counts and files per kind.

## Zero results

When no usage is found, nidan does not report "no impact". It reports **"No static usages found"** together with the relevant gap count.

The distinction matters: finding nothing statically is not evidence of safety. See [what a result means](concepts.md#what-a-result-means).

## Determinism

Identical input produces byte-identical output. The same analysis run twice, on a different machine, or from a different checkout path, yields the same bytes.

This holds because:

- All paths are repository-relative POSIX paths. Absolute paths never appear.
- No timestamps and no machine-specific data are included.
- Seeds are sorted by identity key.
- Usages and gaps are sorted by file, then line, then column, then kind.
- Sorting is locale-independent.
- Line endings are normalized when files are read.
