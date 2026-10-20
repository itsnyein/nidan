# ADR-0012: `tests/helpers/` for test-only helpers

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

The fixture harness built in T0.2 — the code that turns a fixture case into a temporary
Git repository — had no home in the repository layout.

It is not a test: it asserts nothing and is imported by tests. It is not a fixture:
fixtures are data, and are frozen once approved. And it must not live under `src/`,
because everything there is a candidate for the published bundle, and shipping test
machinery to users would be wrong.

## Decision

Test-only helpers live in **`tests/helpers/`**. Their tests mirror the path under
`tests/unit/helpers/`.

A module belongs here when it is imported by tests, ships in no build output, and asserts
nothing itself. Anything consumed by production code belongs in `src/`, even if tests are
currently its only caller.

## Consequences

- There is one obvious place for shared test machinery, so it does not accumulate in
  `tests/unit/` next to the tests that happen to have needed it first.
- Nothing under `tests/` is reachable from the bundle, which has a single entry point
  under `src/`. The separation is structural, not a convention to remember.
- Helpers are still typechecked and linted, because `tests/` is in the TypeScript project
  and the ESLint scope. They are held to the same standards as production code.
- A third place exists for code to live, so "where does this go?" has one more answer. The
  rule above is the tiebreaker.
- The boundary needs watching. A helper that grows useful to production code should move
  to `src/` rather than being imported across the line.

## Alternatives considered

**`src/testing/`.** Keeps all source together. Rejected: it places test machinery in the
published tree, where only an `exports` or `files` exclusion would keep it out of the
package — an easy thing to get wrong silently.

**Alongside its consumer in `tests/unit/`.** Fine for one helper. Rejected because the
harness is shared by every future `E` task and integration test, and a shared module
nested under one consumer's directory invites copies.

**A separate workspace package.** Rejected as disproportionate. `decisions.md` §3 reserves
package splits for when a second real consumer exists; one harness in one package is not
that.
