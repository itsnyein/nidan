# Limitations

> **Status: specified, not yet implemented.** See [Documentation status](README.md#documentation-status).

Every limitation here states what nidan does instead, because the [core guarantee](concepts.md#core-guarantee) requires that nothing is silently dropped. Where a limitation produces a gap, the gap kind is named; the gap kinds themselves are described in [Output](output.md#gap-kinds).

## Analysis limitations

### Interface and override dispatch is detected, not resolved

When a changed method implements an interface member or overrides a base-class method, nidan cannot tell which concrete implementation a given call site reaches.

It reports an `interface-or-override-dispatch` gap rather than claiming or omitting an edge.

### Type-only changes are not seeds

A change to a type or interface that does not touch a function body does not produce a seed, because no callable changed.

It appears as an `unmapped-change` gap. The impact of type-only changes is outside what nidan analyzes.

### A moved or renamed file looks like a delete plus an add

File paths are part of the [identity key](supported-patterns.md#matching-base-against-head). Moving or renaming a file therefore breaks the match: every callable in it is reported as deleted at the old path and added at the new one, even when the body is unchanged.

nidan does not perform rename or move detection.

### Value flow is not followed

`value-reference` records only the immediate use of a callable as a value. nidan does not follow where that value travels afterwards.

Specifically, `.call()`, `.apply()`, `.bind()`, unions of callable types, and data-flow tracing are not followed.

### Dynamic module loading is not resolved

`import()` and `require()` with a non-literal argument cannot be resolved statically. They produce `dynamic-import` and `dynamic-require` gaps.

### Computed member access is not discovered

A key that is a **literal** is an ordinary member call. Both `obj["method"]()` and ``obj[`method`]()`` name the same member as `obj.method()`, so nidan reports each as an `invoke` usage with `exact` resolution.

A key that is written any other way is **not discovered**, and there are two different reasons for that.

**The key genuinely names no member.** `obj[name]()` where `name` is an ordinary `string`, `obj[key + suffix]()`, and a template literal **with substitutions** such as ``obj[`${prefix}method`]()`` select a member at runtime. Nothing in the source says which one.

**The key names a member, but nidan does not follow it.** A constant carrying a literal type does name one, and the compiler agrees:

```ts
const send = "send" as const;
client[send]("payload"); // type-checks, and resolves to Client.send
```

TypeScript resolves that call and will reject it if `send` is not a member. nidan still does not report it. Usage discovery is driven by the compiler's reference search, which returns literal keys written in place and does not return keys reached through a constant — so no reference arrives to be classified. **The limitation is in nidan's discovery, not in the type system**, and saying otherwise would misdescribe what the compiler knows.

Both cases produce **no usage and no gap**: there is no reference to report, rather than one that could not be resolved. They sit with runtime reflection in the [coverage statement](#coverage-statement) — dynamic dependencies nidan does not claim to detect.

The practical consequence is the same either way: if a changed method is only ever reached through a key nidan does not follow, the report shows it with no usages. Treat a dispatch table — keyed by variable or by constant — as outside what the report covers.

### Untyped receivers are not resolved

A member call on a receiver typed `any`, or one whose type cannot be resolved, cannot be attributed to a specific symbol. When the called member matches a seed name, nidan reports an `untyped-member-call` gap.

### Unsupported callable forms

Anonymous callbacks, getters and setters, factory-returned functions, dynamically assigned properties, and object literal methods cannot be seeds. Changes inside them seed the enclosing supported callable, or produce an `unmapped-change` gap.

### Duplicate identity keys stop matching

If the same structural key appears twice within one snapshot, nidan does not guess which declaration corresponds to which. It emits an `ambiguous-identity` gap.

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

If `node_modules` is missing **and** a file nidan analyzed imports a package that does not
resolve, the run is `degraded` with the reason `dependencies-not-installed`.

Both halves matter. A project that imports nothing from `node_modules` resolves perfectly
well without it, and degrading that run would be a false alarm. What counts is whether a
specifier actually resolved, not how it is spelled — a path alias such as `@/lib/slug.js`
looks like a package but is mapped by `paths`, so it needs no dependencies at all.

Individually missing packages produce `unresolved-module` gaps.

If `base` and `head` differ in their `package.json` dependency fields or their lockfile, the report carries a `dependency-manifest-changed` warning listing the changed package names. This is a warning only — it does not degrade the run.

### Import paths must match the committed file's case

nidan compares paths case-sensitively on every platform. An import whose case differs from
the path recorded in Git does not resolve, and is reported as an `unresolved-module` gap.

```ts
// committed as src/format.ts
import { formatRow } from "./Format.js"; // unresolved-module
```

This is deliberate, and it has a cost. On a case-insensitive filesystem — the default on
macOS and Windows — that import works, so a repository can build locally and still be
reported as having an unresolved module here. The same code genuinely fails on a
case-sensitive filesystem, which is what most Linux CI runners and container images use.

Matching the host filesystem instead would make nidan's output depend on the machine it ran
on, which the [determinism rules](output.md#determinism) forbid. Reporting the stricter
answer everywhere also surfaces a real portability bug rather than hiding it.

### Paths outside the repository are denied

Module resolution is confined to the repository and its `node_modules`. A path that escapes the repository is denied, surfacing as an `unresolved-module` gap or a configuration reason.

### Untrusted repositories are out of scope

The security model for analyzing untrusted repositories is not part of Phase 1. nidan is intended to run as a local CLI against your own repository.

nidan never installs dependencies, never accesses the network, never runs lifecycle scripts, and never executes repository code — but the TypeScript compiler is not a sandbox, and that threat model is deferred.

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

Because of these categories, nidan never claims to detect all impact. A result means [potentially affected](concepts.md#what-a-result-means), and an empty result is not a safety signal.
