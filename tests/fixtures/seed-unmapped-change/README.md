# seed-unmapped-change

**Proves:** a change that maps to no callable is reported as an `unmapped-change` gap, not
silently dropped.

`Options` gains an optional `timeoutMs`. Nothing inside any function body changes, so
there is no seed — but the diff hunk is real and must be accounted for.

This is the core guarantee applied to the diff rather than to references: **no diff hunk
is silently ignored**. A type-only change genuinely can affect callers, and nidan cannot
say how, so it reports that it could not map the change rather than implying there was
nothing to map.

`use.ts` is identical in both snapshots and compiles against both versions of `Options`,
so the only change in the diff is the one being tested.
