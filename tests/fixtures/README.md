# Fixtures

One fixture case tests one behavior. A case is a directory:

```text
<case>/
├── base/          # the source tree at the base ref
├── head/          # the source tree at the head ref
├── expected.json  # the golden expectation, written by hand
└── README.md      # the single behavior under test, and why
```

The harness in `tests/helpers/fixture-repo.ts` builds a temporary Git repository with two
commits from `base/` and `head/`, reachable as the refs `base` and `head`. Tests run omen
against that repository and compare the result with `expected.json`.

## Rules

**Golden expectations are written by humans.** They are never generated from omen's
output. A generated expectation asserts that the tool does what it does, which is not a
test. Each value in an `expected.json` was derived from the behavior documentation and
checked by hand against the fixture's source.

**Approved fixtures are frozen.** Once a case is merged it may only be changed by another
`E` task. An implementation task that finds a fixture inconvenient has found a bug in the
implementation, a gap in the specification, or a wrong expectation — all three need a
decision, not an edit.

**One behavior per case.** A case that asserts three things fails for three reasons and
tells you nothing about which. Prefer another directory.

## `expected.json` format

Until the JSON report schema is frozen in T5.2, an expectation is a **subset match**: the
`expect` object names only the fields this case asserts, and every one must appear in the
report with that value. Fields the case does not mention are not constrained.

```json
{
  "description": "what this case proves, in one line",
  "expect": {
    "run": { "status": "ok" }
  }
}
```

This keeps expectations honest about their scope and stops unrelated schema additions from
breaking every case. When the schema is frozen, cases that should assert a whole report
can be tightened deliberately.

## Cases

| Case                                                       | Proves                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| [`overlay-basic`](overlay-basic/README.md)                 | Each snapshot is served from its own Git objects |
| [`leak-working-tree`](leak-working-tree/README.md)         | The working tree never reaches results           |
| [`config-tsconfig`](config-tsconfig/README.md)             | A real `tsconfig.json` is discovered and used    |
| [`config-jsconfig-paths`](config-jsconfig-paths/README.md) | `jsconfig.json` `paths` aliases resolve          |
| [`config-absent`](config-absent/README.md)                 | A missing config degrades the run, and says why  |
| [`manifest-changed`](manifest-changed/README.md)           | A dependency change warns without degrading      |
