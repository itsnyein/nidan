# usage-equivalence-jsx

**Proves:** the `.jsx` member of the four-variant equivalence group — the same case as
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) reports the same usage when
the files are `.jsx`.

```
src/greet.jsx :: :: function :: greet
```

One usage, in `src/use.jsx` at line 4, `from src/use.jsx :: :: function :: report`.

## Why this shape

The sources are **byte-identical** to the other three variants; see
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) for why the case has no
parameters, no annotations, and a `./greet.js` specifier, and
[`usage-equivalence-js`](../usage-equivalence-js/README.md) for why `checkJs` is on and
why the manifest declares `"type": "module"`. This variant needs the union of both sets of
options: `allowJs`, `checkJs`, and `"jsx": "preserve"`.

**`.jsx` is the variant most likely to be handled by accident.** It is the only one of the
four that is neither the default TypeScript extension nor the default JavaScript one, so
an extension list written from memory tends to omit it, and `allowJs` has to cover it for
the file to enter the program at all. The import specifier is still `./greet.js`, which
exercises the one resolution step unique to this variant: `.js` in a specifier must map to
a `.jsx` file on disk. If it did not, `greet` would resolve to nothing, the reference
would not be found, and the usage would **disappear** rather than fail loudly — which is
why the group's rule is that a reference that does not resolve must surface as a gap.
