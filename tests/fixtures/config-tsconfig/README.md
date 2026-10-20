# config-tsconfig

**Proves:** a `tsconfig.json` committed in the snapshot is discovered and used, and the
run is `ok` with no reasons.

The call to `greet` sits at module top level rather than inside a function, so `from` is
the module node. That is deliberate: it is the smallest case that exercises the module
node alongside config discovery, and the module node is easy to get wrong by attributing
the usage to the file's first callable instead.

Note the config is read from the **snapshot**, not from disk. The temporary repository has
no working-tree config of its own beyond what the fixture commits.
