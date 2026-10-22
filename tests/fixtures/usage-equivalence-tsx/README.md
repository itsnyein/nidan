# usage-equivalence-tsx

**Proves:** the `.tsx` member of the four-variant equivalence group — the same case as
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) reports the same usage when
the files are `.tsx`.

```
src/greet.tsx :: :: function :: greet
```

One usage, in `src/use.tsx` at line 4, `from src/use.tsx :: :: function :: report`.

## Why this shape

The sources are **byte-identical** to the other three variants; see
[`usage-equivalence-ts`](../usage-equivalence-ts/README.md) for why the case has no
parameters, no annotations, and a `./greet.js` specifier. The only difference here is the
extension and the one option it requires, `"jsx": "preserve"`.

**Why a `.tsx` file with no JSX in it.** The extension changes how TypeScript _parses_
before it changes anything else: in `.tsx`, `<T>expr` is a JSX element rather than a type
assertion, and the file is handed to a different scanner mode. A case that proves
equivalence has to hold the source constant and vary only the extension, so putting JSX in
this variant would make it a different case rather than the same one. JSX rendering as a
_relation_ is `jsx-render` and belongs to a fixture of its own; this group is about the
extension, not the syntax.

`"jsx": "preserve"` is chosen over `react-jsx` because it needs no runtime type
declarations — `react-jsx` would pull `react/jsx-runtime` into the case and make an
uninstalled dependency part of what the fixture tests.
