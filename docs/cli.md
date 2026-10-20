# CLI

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

## Inputs

| Input         | Required | Default                          | Purpose                                        |
| ------------- | -------- | -------------------------------- | ---------------------------------------------- |
| `base` ref    | Yes      | —                                | The ref to compare from                        |
| `head` ref    | Yes      | —                                | The ref to compare to                          |
| Project root  | No       | Current working directory        | The repository to analyze                      |
| Config path   | No       | Discovered from the project root | An explicit `tsconfig.json` or `jsconfig.json` |
| Output format | No       | —                                | `text` or `json`                               |

The exact flag spellings are fixed when the argument surface is implemented. Once published they become part of the [public contract](README.md#what-is-public-contract).

## Refs and what is compared

Both refs are validated before any analysis begins. A ref that does not resolve is an input error. A ref beginning with `-` is rejected rather than being passed through as an option.

The comparison uses merge-base semantics, matching a pull request diff: `merge-base(base, head)` against `head`. The resolved commit SHAs appear in the report.

A base ref that is missing because the repository is a shallow clone fails with a clear message rather than analyzing a partial history.

The working tree is never modified, and never read for source files. See [where source comes from](concepts.md#where-source-comes-from).

## Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | The analysis run completed — run status `ok` or `degraded`     |
| `1`  | The analysis failed — a snapshot or config could not be loaded |
| `2`  | Usage or input error, such as an invalid ref or a bad argument |

**Exit codes never depend on results.** A run that finds a hundred usages and a run that finds none both exit `0`. This is deliberate: it stops a CI pipeline from reading "zero usages" as "safe", which the [coverage statement](limitations.md#coverage-statement) does not support.

To act on results in CI, read the JSON output.

## Run status

The report carries a run status describing how the analysis executed.

| Status     | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `ok`       | Completed with a real config and no blocking diagnostics in the affected files |
| `degraded` | Completed, but something reduced confidence. Reasons are listed in the report  |
| `failed`   | A snapshot or config could not be loaded; there are no results                 |

A run is `degraded` when an inferred configuration was used instead of a real one, when
compiler diagnostics exist in seed or usage files, or when
[dependencies are needed but not installed](limitations.md#dependencies-come-from-the-working-tree)
— reported as `dependencies-not-installed`.

**Run status describes tool execution only.** It says nothing about how complete the impact analysis is. An `ok` run is still bounded by the [supported patterns](supported-patterns.md) and the coverage statement.

Warnings are separate from status. A [dependency manifest change](limitations.md#dependencies-come-from-the-working-tree) between the two refs is reported as a warning while the status stays `ok`.

## Configuration discovery

omen reads `tsconfig.json` or `jsconfig.json` from the snapshot, honoring `baseUrl` and `paths`. When neither exists, it infers a configuration and marks the run `degraded`.

Compiler options from your configuration are not overridden, with one exception: `allowJs` is enabled so that `.js` and `.jsx` files are analyzed.

## Safety

omen never installs dependencies, never accesses the network, never runs lifecycle scripts, and never executes code from the repository under analysis.

Git is invoked directly with argument arrays, never through a shell.
