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
commits from `base/` and `head/`, reachable as the refs `base` and `head`. Tests run nidan
against that repository and compare the result with `expected.json`.

## Rules

**Golden expectations are written by humans.** They are never generated from nidan's
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

| Case                                                                               | Proves                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`overlay-basic`](overlay-basic/README.md)                                         | Each snapshot is served from its own Git objects                 |
| [`config-tsconfig`](config-tsconfig/README.md)                                     | A real `tsconfig.json` is discovered and used                    |
| [`config-jsconfig-paths`](config-jsconfig-paths/README.md)                         | `jsconfig.json` `paths` aliases resolve                          |
| [`config-absent`](config-absent/README.md)                                         | A missing config degrades the run, and says why                  |
| [`manifest-changed`](manifest-changed/README.md)                                   | A dependency change warns without degrading                      |
| [`layout-npm`](layout-npm/README.md)                                               | Types resolve under a flat npm layout                            |
| [`layout-yarn`](layout-yarn/README.md)                                             | Types resolve with a nested transitive dependency                |
| [`layout-pnpm`](layout-pnpm/README.md)                                             | Types resolve through pnpm's symlinked layout                    |
| [`leak-uncommitted`](leak-uncommitted/README.md)                                   | A self-contained proof that the work tree is invisible           |
| [`identity-overload`](identity-overload/README.md)                                 | Overloads and their implementation are one callable              |
| [`identity-nested`](identity-nested/README.md)                                     | The container chain separates same-named nested functions        |
| [`identity-nested-two-level`](identity-nested-two-level/README.md)                 | A container chain two levels deep, separated by `.`              |
| [`identity-nested-static-collision`](identity-nested-static-collision/README.md)   | The static marker is not in the chain, so nested names collide   |
| [`identity-default-exports`](identity-default-exports/README.md)                   | Named, anonymous, and aliased default exports each key correctly |
| [`identity-re-export`](identity-re-export/README.md)                               | A barrel re-export does not create a second identity             |
| [`identity-static-vs-instance`](identity-static-vs-instance/README.md)             | The static marker separates a static from an instance method     |
| [`identity-constructor`](identity-constructor/README.md)                           | A constructor resolves through its class, including `super()`    |
| [`identity-collision`](identity-collision/README.md)                               | A duplicate key is reported, never guessed                       |
| [`seed-whitespace-only`](seed-whitespace-only/README.md)                           | Reformatting alone produces no seed                              |
| [`seed-comment-change`](seed-comment-change/README.md)                             | A comment change is a modification                               |
| [`seed-declaration-form-change`](seed-declaration-form-change/README.md)           | The declaration form does not affect the key                     |
| [`seed-added-deleted`](seed-added-deleted/README.md)                               | Added, deleted, and untouched classified in one diff             |
| [`seed-unmapped-change`](seed-unmapped-change/README.md)                           | A change mapping to no callable becomes a gap                    |
| [`seed-mixed-hunk`](seed-mixed-hunk/README.md)                                     | One hunk yields both a seed and a gap                            |
| [`seed-overload-hull-gap`](seed-overload-hull-gap/README.md)                       | An overload set owns each declaration, not the hull              |
| [`seed-declaration-keyword`](seed-declaration-keyword/README.md)                   | The declaration keyword is part of every declarator's signature  |
| [`seed-declaration-keyword-one-line`](seed-declaration-keyword-one-line/README.md) | The same rule with both declarators on one line                  |
| [`seed-boundary-insert-between`](seed-boundary-insert-between/README.md)           | An insertion between two functions belongs to neither            |
| [`seed-boundary-delete-between`](seed-boundary-delete-between/README.md)           | A deletion between two functions belongs to neither              |
| [`seed-boundary-insert-body-first`](seed-boundary-insert-body-first/README.md)     | An insertion inside a body seeds that callable                   |
| [`seed-boundary-insert-body-last`](seed-boundary-insert-body-last/README.md)       | The same at a body's closing edge                                |
| [`usage-equivalence-ts`](usage-equivalence-ts/README.md)                           | A changed function has one usage, from its caller                |
| [`usage-equivalence-tsx`](usage-equivalence-tsx/README.md)                         | The same case in `.tsx` reports the same usage                   |
| [`usage-equivalence-js`](usage-equivalence-js/README.md)                           | The same case in `.js` reports the same usage                    |
| [`usage-equivalence-jsx`](usage-equivalence-jsx/README.md)                         | The same case in `.jsx` reports the same usage                   |
| [`usage-cross-ts-uses-js`](usage-cross-ts-uses-js/README.md)                       | A JavaScript callable used from TypeScript resolves exactly      |
| [`usage-cross-js-uses-ts`](usage-cross-js-uses-ts/README.md)                       | A TypeScript callable used from JavaScript resolves exactly      |
| [`usage-barrel-two-hops`](usage-barrel-two-hops/README.md)                         | Two re-export hops still yield one usage                         |
| [`usage-constructor-cross-file`](usage-constructor-cross-file/README.md)           | `new` and a subclass `super()` in separate modules               |
| [`usage-constructor-implicit`](usage-constructor-implicit/README.md)               | A subclass with no constructor still constructs its base         |
| [`usage-member-calls`](usage-member-calls/README.md)                               | Instance, static, and `["literal"]` calls all report `invoke`    |
| [`usage-value-position`](usage-value-position/README.md)                           | A mixin call in `extends` and a tagged template are `invoke`     |
| [`usage-commonjs-require`](usage-commonjs-require/README.md)                       | The three supported `require` spellings reach one seed           |
| [`usage-commonjs-exports`](usage-commonjs-exports/README.md)                       | CommonJS export spellings are module patterns, not usages        |
| [`gap-interface-dispatch`](gap-interface-dispatch/README.md)                       | Implementing an interface member emits the dispatch gap          |
| [`gap-override-dispatch`](gap-override-dispatch/README.md)                         | Overriding a base method emits the dispatch gap                  |
| [`gap-untyped-member-call`](gap-untyped-member-call/README.md)                     | A member call on an `any` receiver emits a gap, not a usage      |
