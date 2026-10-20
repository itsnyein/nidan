# leak-uncommitted

**Proves:** the working tree never reaches results. Self-contained — the case carries its
own dirty state, so no setup is pushed onto the consuming test.

The harness overlays `worktree/` after both commits:

- `src/calc.ts` becomes a **third** variant, different from base and from head. If the
  working tree leaked, the seed's body would be the `* 999` version rather than head's
  `* 2`.
- `src/untracked.ts` is a new untracked file that calls `total`. If untracked files were
  visible, there would be **two** usages instead of one.

Exactly one usage is expected, from `src/report.ts`. The count is the assertion.

`leak-working-tree` describes the same setup in prose and relies on its consuming test to
perform it. A case that depends on an external step passes trivially when that step is
forgotten, which is the one failure mode a leak test must not have — so this case exists
to replace it. Removing the older case needs maintainer approval, since it is already
approved and frozen; until then both are present and only this one is self-contained.
