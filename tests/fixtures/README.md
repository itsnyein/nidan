# Fixtures

One fixture case tests one behavior. A case is a directory:

```text
<case>/
├── base/           # the source tree at the base ref
├── head/           # the source tree at the head ref
├── node_modules/   # optional: installed dependencies, never committed
├── worktree/       # optional: files overlaid on the work tree, never committed
├── links.json      # optional: directory symlinks to create in the work tree
├── expected.json   # the golden expectation, written by hand
└── README.md       # the single behavior under test, and why
```

`base/` and `head/` become the two commits. Everything else lands **after** the commits
and exists only in the work tree, which is what makes it useful:

- **`node_modules/`** — dependencies are read from disk, never from a snapshot, so a case
  that needs installed packages puts them here.
- **`worktree/`** — an overlay, not a replacement. It names only the files that should
  differ from head, which is how a leak case makes the work tree disagree with the
  committed tree, and how it adds an untracked file.
- **`links.json`** — `{ "links": [{ "path": "...", "target": "..." }] }`, both
  repository-relative. Directory links only.

Symlinks are described in a manifest rather than committed, because Git for Windows checks
symlinks out as plain text files by default: a committed pnpm layout would silently become
a directory of path strings there. Creating them at test time gives one representation that
works everywhere — real symlinks on POSIX, junctions on Windows, which need no elevated
privileges and resolve through `realpath` the same way.

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

| Case                                                                     | Proves                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [`overlay-basic`](overlay-basic/README.md)                               | Each snapshot is served from its own Git objects                 |
| [`config-tsconfig`](config-tsconfig/README.md)                           | A real `tsconfig.json` is discovered and used                    |
| [`config-jsconfig-paths`](config-jsconfig-paths/README.md)               | `jsconfig.json` `paths` aliases resolve                          |
| [`config-absent`](config-absent/README.md)                               | A missing config degrades the run, and says why                  |
| [`manifest-changed`](manifest-changed/README.md)                         | A dependency change warns without degrading                      |
| [`layout-npm`](layout-npm/README.md)                                     | Types resolve under a flat npm layout                            |
| [`layout-yarn`](layout-yarn/README.md)                                   | Types resolve with a nested transitive dependency                |
| [`layout-pnpm`](layout-pnpm/README.md)                                   | Types resolve through pnpm's symlinked layout                    |
| [`leak-uncommitted`](leak-uncommitted/README.md)                         | A self-contained proof that the work tree is invisible           |
| [`identity-overload`](identity-overload/README.md)                       | Overloads and their implementation are one callable              |
| [`identity-nested`](identity-nested/README.md)                           | The container chain separates same-named nested functions        |
| [`identity-default-exports`](identity-default-exports/README.md)         | Named, anonymous, and aliased default exports each key correctly |
| [`identity-re-export`](identity-re-export/README.md)                     | A barrel re-export does not create a second identity             |
| [`identity-static-vs-instance`](identity-static-vs-instance/README.md)   | The static marker separates a static from an instance method     |
| [`identity-constructor`](identity-constructor/README.md)                 | A constructor resolves through its class, including `super()`    |
| [`identity-collision`](identity-collision/README.md)                     | A duplicate key is reported, never guessed                       |
| [`seed-whitespace-only`](seed-whitespace-only/README.md)                 | Reformatting alone produces no seed                              |
| [`seed-comment-change`](seed-comment-change/README.md)                   | A comment change is a modification                               |
| [`seed-declaration-form-change`](seed-declaration-form-change/README.md) | The declaration form does not affect the key                     |
| [`seed-added-deleted`](seed-added-deleted/README.md)                     | Added, deleted, and untouched classified in one diff             |
| [`seed-unmapped-change`](seed-unmapped-change/README.md)                 | A change mapping to no callable becomes a gap                    |
