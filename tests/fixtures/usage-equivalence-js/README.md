# usage-equivalence-js

**Proves:** the `.js` member of the four-variant equivalence group — the same case as
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) reports the same usage when
the files are `.js`.

```
src/greet.js :: :: function :: greet
```

One usage, in `src/use.js` at line 4, `from src/use.js :: :: function :: report`.

## Why this shape

The sources are **byte-identical** to the other three variants; see
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) for why the case has no
parameters, no annotations, and a `./greet.js` specifier. The only difference here is the
extension and the two options it requires, `allowJs` and `checkJs`.

**Why `checkJs: true`.** Without it the compiler parses and binds the JavaScript files but
does not check them, which is a second difference from the `.ts` variant on top of the
extension. If this variant then reported a different usage, "JavaScript resolves
differently" and "JavaScript was not checked" would both explain it and the fixture could
not separate them. Turning checking on makes the variants differ in the extension alone.
It costs nothing here: both snapshots load with zero diagnostics.

**Why `"type": "module"` in `package.json`.** Under `module: NodeNext` a `.js` file's
module format comes from the nearest `package.json`. Without it these files would be
CommonJS and their `import`/`export` statements would be errors — the case would fail for
a reason that has nothing to do with usage discovery. All four variants carry the same
manifest so this is not a difference between them either.
