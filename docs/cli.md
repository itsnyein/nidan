# CLI

> **Status: implemented**, except that the `degraded` reason for compiler diagnostics activates with seed mapping (M2). See [Documentation status](README.md#documentation-status).

## Usage

```
nidan <base> <head> [options]
```

## Arguments and flags

| Flag                     | Input                                       | Default                             | Example                                               |
| ------------------------ | ------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| `<base>`                 | The ref to compare from                     | required                            | `nidan main feature`                                  |
| `<head>`                 | The ref to compare to                       | required                            | `nidan main feature`                                  |
| `-C, --directory <path>` | Project directory to analyze                | current directory                   | `nidan main HEAD -C ../app`                           |
| `--config <path>`        | Explicit `tsconfig.json` or `jsconfig.json` | discovered from the repository root | `nidan main HEAD --config packages/web/tsconfig.json` |
| `--format <format>`      | Output format: `text` or `json`             | `text`                              | `nidan main HEAD --format json`                       |
| `-V, --version`          | Print the version and exit                  | —                                   | `nidan --version`                                     |
| `-h, --help`             | Print help and exit                         | —                                   | `nidan --help`                                        |

## How paths resolve

`--directory` is the directory nidan behaves as though it were started in, the same sense
git gives `-C`. It resolves against the directory you ran the command from.

Everything else relative resolves against **`--directory`**, not against the directory you
ran from. Moving where you invoke nidan, without moving the paths you pass, can never
silently change which files it reads.

- `--directory` resolves against the invocation directory.
- `--config` resolves against `--directory`. An absolute path is used as given.
- The **repository root** is discovered by searching upward from `--directory`, so a
  subdirectory is a valid place to start.
- Paths in the output are **repository-relative** and POSIX, never absolute. See
  [determinism](output.md#determinism).

```sh
# From anywhere: analyze ../app with the config at ../app/packages/web/tsconfig.json
nidan main HEAD -C ../app --config packages/web/tsconfig.json
```

A `--config` that resolves outside the repository, or to a file absent from the compared
snapshot, is an input error and exits `2`.

These spellings are [public contract](README.md#what-is-public-contract). Changing one is
a breaking change.

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

nidan reads `tsconfig.json` or `jsconfig.json` from the snapshot, honoring `baseUrl` and `paths`. When neither exists, it infers a configuration and marks the run `degraded`.

Compiler options from your configuration are not overridden, with one exception: `allowJs` is enabled so that `.js` and `.jsx` files are analyzed.

## Safety

nidan never installs dependencies, never accesses the network, never runs lifecycle scripts, and never executes code from the repository under analysis.

Git is invoked directly with argument arrays, never through a shell.
