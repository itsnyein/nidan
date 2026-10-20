# layout-npm

**Proves:** dependency types resolve under a flat npm `node_modules` layout.

`tiny-ui` and its transitive dependency `tiny-dep` are both hoisted to the top level,
which is what npm produces when there is no version conflict. `tiny-ui`'s types import
from `tiny-dep`, so resolution has to walk up from the dependent to the top level.

The changed callable is `Card`, used as JSX by `App`. The assertion that carries the
weight is `repoWideGaps: []`: if the layout were not handled, `tiny-ui` would be an
`unresolved-module` gap, `Panel` would be untyped, and the JSX usage could not be
classified with `exact` resolution.

Dependencies live in the case's `node_modules/`, which the harness copies into the work
tree **after** both commits. They are never committed — omen reads dependencies from
disk, not from a snapshot, and this case would be meaningless if they came from Git.
