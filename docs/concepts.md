# Concepts

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

## What omen does

Given two Git refs, `base` and `head`, omen:

1. Finds the named callables that changed.
2. Reports each changed callable's direct usages, with TypeScript compiler evidence.
3. Reports anything static analysis cannot confirm as an analysis gap, never as a guessed edge.

## What a result means

A reported usage means **potentially affected**. It does not mean the code behaves differently, and it does not mean the usage is broken.

omen reports where a changed callable is referred to. Whether that reference is affected depends on what changed inside the callable, which omen does not evaluate.

The inverse also holds: an empty result does not mean a change is safe. It means no static usage was found within the supported patterns. Always read it together with the gap counts and the [coverage statement](limitations.md#coverage-statement).

## Core guarantee

> Within supported static analysis patterns, there is no unexplained reference.

For a changed symbol, every occurrence that refers to it falls into exactly one of three outcomes:

- a reported usage,
- a filtered non-usage — a declaration site, or an import or export specifier,
- a reported analysis gap.

Nothing is silently dropped.

This guarantee is scoped to the [supported patterns](supported-patterns.md). It does **not** claim to detect every dynamic runtime dependency. The categories omen does not analyze by design are listed in the [coverage statement](limitations.md#coverage-statement).

## Vocabulary

| Term             | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| **Snapshot**     | The source tree of one Git ref, `base` or `head`                                                       |
| **Callable**     | A function-like declaration whose identity omen can establish                                          |
| **Seed**         | A callable changed by the diff                                                                         |
| **Usage**        | An evidence-backed relation referring to a seed                                                        |
| **Analysis gap** | A record describing an uncertain target, or something that could not be analyzed. A gap is not an edge |
| **Module node**  | A synthetic origin representing top-level code with no enclosing callable                              |

## What is compared

The default comparison uses merge-base semantics, the same as a pull request diff on GitHub: omen compares `merge-base(base, head)` against `head`.

The report shows the resolved commit SHAs that were actually compared, so the comparison is never ambiguous.

## Where source comes from

Source files for both snapshots are read **only from Git objects**. The working tree is never touched and never enters the analysis.

A consequence worth stating plainly: uncommitted edits and untracked files are invisible to omen. A path inside the repository that is not present in the snapshot is simply not found — there is no fallback to disk.

Dependencies are the exception. They are read from the working tree's `node_modules` on disk, because a snapshot of the repository does not contain them.

| Source                           | Read from               | Role                                                |
| -------------------------------- | ----------------------- | --------------------------------------------------- |
| Repository source files          | Git objects             | Analyzed; can be seeds and usage sources            |
| `node_modules`                   | Working tree, read-only | Type information only; never seeds or usage sources |
| The project's own `package.json` | Git objects             | `type`, `imports`, and `exports` affect resolution  |
| Dependency `package.json` files  | Working tree            | Resolution of installed packages                    |

Because dependencies come from the current working tree rather than from history, analysis of an old `base` ref uses today's installed packages. Historical dependency accuracy is not guaranteed.

Line endings are normalized when files are read, so results do not depend on the platform a repository was checked out on.

## Which snapshot is used

Seeds and usages are not always taken from the same snapshot. It depends on how the callable changed.

| Change   | Seeds come from               | Usages come from |
| -------- | ----------------------------- | ---------------- |
| Added    | Head                          | Head             |
| Deleted  | Base                          | Base             |
| Modified | Base and Head, matched by key | Head             |

For a deleted callable, usages are reported from `base` — that is where the callers still exist.

## Analysis TypeScript version

Analysis runs on the TypeScript version bundled by ts-morph, which is pinned exactly. That version is reported in the output, because analysis results depend on it.

omen also has a development dependency on TypeScript, used only to typecheck and lint omen itself. It may differ from the analysis version and has no effect on results.

## What omen never does

omen never installs dependencies, never accesses the network, never runs lifecycle scripts, and never executes any code from the repository under analysis.
