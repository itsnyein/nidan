# Limitations

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

Every limitation here states what omen does instead, because the [core guarantee](concepts.md#core-guarantee) requires that nothing is silently dropped. Where a limitation produces a gap, the gap kind is named; the gap kinds themselves are described in [Output](output.md#gap-kinds).

## Analysis limitations

### Interface and override dispatch is detected, not resolved

When a changed method implements an interface member or overrides a base-class method, omen cannot tell which concrete implementation a given call site reaches.

It reports an `interface-or-override-dispatch` gap rather than claiming or omitting an edge.

### Type-only changes are not seeds

A change to a type or interface that does not touch a function body does not produce a seed, because no callable changed.

It appears as an `unmapped-change` gap. The impact of type-only changes is outside what omen analyzes.

### A moved or renamed file looks like a delete plus an add

File paths are part of the [identity key](supported-patterns.md#matching-base-against-head). Moving or renaming a file therefore breaks the match: every callable in it is reported as deleted at the old path and added at the new one, even when the body is unchanged.

omen does not perform rename or move detection.

### Value flow is not followed

`value-reference` records only the immediate use of a callable as a value. omen does not follow where that value travels afterwards.

Specifically, `.call()`, `.apply()`, `.bind()`, unions of callable types, and data-flow tracing are not followed.

### Dynamic module loading is not resolved

`import()` and `require()` with a non-literal argument cannot be resolved statically. They produce `dynamic-import` and `dynamic-require` gaps.

### Untyped receivers are not resolved

A member call on a receiver typed `any`, or one whose type cannot be resolved, cannot be attributed to a specific symbol. When the called member matches a seed name, omen reports an `untyped-member-call` gap.

### Unsupported callable forms

Anonymous callbacks, getters and setters, factory-returned functions, dynamically assigned properties, and object literal methods cannot be seeds. Changes inside them seed the enclosing supported callable, or produce an `unmapped-change` gap.

### Duplicate identity keys stop matching

If the same structural key appears twice within one snapshot, omen does not guess which declaration corresponds to which. It emits an `ambiguous-identity` gap.

## Repository and environment limitations

### Single-package projects only

Monorepos and workspaces are not supported in Phase 1.

### Symlinks and submodules are skipped

Symlinked entries and Git submodules in a snapshot are skipped and counted in the run reasons.

This does not apply to dependencies: pnpm's symlinked `node_modules/.pnpm` layout is supported, because `node_modules` is read from disk.

### Yarn Plug'n'Play is not supported

npm, pnpm, and yarn `node_modules` layouts are supported. PnP is not.

### Dependencies come from the working tree

Dependencies resolve from the current working tree's `node_modules`, not from either snapshot. Analysis of an old ref therefore uses today's installed packages.

If `node_modules` is missing entirely, the run is `degraded` with the reason `dependencies-not-installed`. Individually missing packages produce `unresolved-module` gaps.

If `base` and `head` differ in their `package.json` dependency fields or their lockfile, the report carries a `dependency-manifest-changed` warning listing the changed package names. This is a warning only — it does not degrade the run.

### Paths outside the repository are denied

Module resolution is confined to the repository and its `node_modules`. A path that escapes the repository is denied, surfacing as an `unresolved-module` gap or a configuration reason.

### Untrusted repositories are out of scope

The security model for analyzing untrusted repositories is not part of Phase 1. omen is intended to run as a local CLI against your own repository.

omen never installs dependencies, never accesses the network, never runs lifecycle scripts, and never executes repository code — but the TypeScript compiler is not a sandbox, and that threat model is deferred.

## Not in Phase 1

These are absent by design, not defects:

- Transitive callers — only direct usages are reported
- Monorepos and workspaces
- Rename and move detection
- Framework conventions: Next.js routes, Server Actions, `next/dynamic`, and React wrapper unwrapping such as `memo` or `forwardRef`
- Interface and override dispatch resolution
- Data-flow tracing
- Caller delta — comparing the callers in `base` with those in `head`
- GitHub integration, AI explanation, and a web interface
- Performance optimization; Phase 1 measures a baseline only

## Coverage statement

Every report includes this statement. These categories are **not analyzed by design**, and no amount of static evidence will surface them:

- **Runtime reflection** — dynamic property access, metaprogramming
- **Framework conventions** — routing, entry points, and lifecycle wiring supplied by a framework
- **Dependency injection, events, and context** — indirection resolved at runtime
- **Configuration and environment-driven wiring** — behavior selected by config values or environment variables
- **Network, API, and database boundaries** — anything crossing a process boundary
- **Transitive impact** — callers of callers
- **Impact of type-only changes**
- **Historical dependency accuracy** — dependencies come from the working tree, not from the compared refs

Because of these categories, omen never claims to detect all impact. A result means [potentially affected](concepts.md#what-a-result-means), and an empty result is not a safety signal.
