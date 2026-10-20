# leak-working-tree

**Proves:** the working tree never reaches results.

The test that consumes this case must, after the repository is built and before omen runs:

1. Overwrite `src/calc.ts` in the working tree with content that differs from head — for
   example a third variant of `total`.
2. Write an untracked file, `src/untracked.ts`, containing another callable and a call to
   `total`.

Neither may appear in the result. The expectation below is exactly what head alone
produces: one seed, one usage from `src/report.ts`, and no usage from `src/untracked.ts`.

This is the case that fails loudly if a snapshot read ever falls back to disk. A disk
fallback is invisible in ordinary use — it silently makes results depend on uncommitted
state — so it needs a fixture that cannot pass unless the fallback is absent.
