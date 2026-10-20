# layout-pnpm

**Proves:** dependency types resolve through pnpm's symlinked layout.

Real package files live under `node_modules/.pnpm/<name>@<version>/node_modules/<name>`.
Two directory links, declared in `links.json`, make the tree look like the other layouts:

- `node_modules/tiny-ui` → the real `tiny-ui` under `.pnpm`
- `.pnpm/tiny-ui@1.0.0/node_modules/tiny-dep` → the real `tiny-dep` under `.pnpm`

This is the layout that forces `realpath` resolution. A resolver that treats
`node_modules/tiny-ui` as a plain directory and never resolves the link will not find
`tiny-dep`, because the second link only exists beside the _real_ `tiny-ui`, not beside
the link to it.

The links are created by the harness at test time rather than committed, because Git for
Windows checks symlinks out as plain text files by default — a committed layout would
silently become a directory of path strings and the case would prove nothing. On Windows
the harness creates junctions, which need no elevated privileges and resolve through
`realpath` identically.
