# layout-yarn

**Proves:** dependency types resolve when a transitive dependency is nested rather than
hoisted.

Same source as `layout-npm`, but `tiny-dep` sits at
`node_modules/tiny-ui/node_modules/tiny-dep` instead of the top level. This is what a
yarn node-modules install produces when a version conflict prevents hoisting, and it is
the case that breaks a resolver which only ever looks at the top-level `node_modules`.

Resolution must find `tiny-dep` from inside `tiny-ui` by walking up from the importing
file, which reaches the nested directory first.

Yarn Plug'n'Play is **not** covered: it is documented as unsupported.
