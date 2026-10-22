# nidan documentation

nidan compares two Git refs in a JavaScript/TypeScript repository, finds the named callables that changed, and reports their direct usages with TypeScript compiler evidence.

The meaning of the output is **"potentially affected"**. It never guarantees behavioral impact.

## Documents

| Document                                    | Contents                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Concepts](concepts.md)                     | The analysis model and its vocabulary: snapshots, callables, seeds, usages, gaps, and what a result means |
| [Supported patterns](supported-patterns.md) | What nidan resolves with compiler evidence, and how a change becomes a seed                               |
| [Limitations](limitations.md)               | What nidan does not resolve, what it reports instead, and the coverage statement                          |
| [CLI](cli.md)                               | Inputs, exit codes, and run status                                                                        |
| [Output](output.md)                         | Report structure, usage kinds, gap kinds, ordering, and determinism                                       |
| [Decision records](adr/README.md)           | Why nidan is built the way it is, and what each choice costs                                              |

## What is public contract

These are contract. Changing any of them is a breaking change:

- CLI flags and arguments
- Exit codes
- The JSON report schema
- The supported patterns and limitations documented here

Text output is **not** a stable contract. Its wording and layout may change at any time; parse the JSON output instead.

The JSON report carries a `schemaVersion` that is versioned independently of the package version.

## Documentation status

Phase 1 is specified but not yet fully built. Every document in this set opens with a status line:

> **Status: specified, not yet implemented.**

The line states that the document describes agreed Phase 1 behavior that does not exist in code yet. The task that implements a given area removes the line from the matching document. A document without the line describes behavior you can rely on from the version that ships it.

A document that is implemented apart from one named part says so, rather than claiming either extreme. [CLI](cli.md) is the current example: its flags and exit codes are contract today, while one `degraded` reason waits on later work.
