# seed-declaration-form-change

**Proves:** `declarationKind` is a property of the callable, not of the AST node that
declares it.

`formatRow` is a function declaration in base and an arrow-expression variable in head,
with the same body. Both key as:

```
src/format.ts :: :: function :: formatRow
```

so this is **one seed, `modified`** — and the caller in `use.ts` is still reported.

An implementation that derives `declarationKind` from the syntax node fails here: it would
key base as a function declaration and head as a variable, see no match, and report a
delete plus an add. That is the wrong answer twice over. The callable did not go away, and
the usage report — the thing someone changing a declaration form actually wants — would be
lost, since a deleted callable reports usages from base and an added one from head.

`declarationKind` is a closed set of `function`, `method`, and `constructor`. `function`
covers every form that declares a free-standing callable: function declarations, named
variables holding arrow or function expressions, and named or anonymous default exports.

The call sits inside `rows.map((row) => ...)`. That arrow is an anonymous callback and not
a supported callable, so `from` is the nearest enclosing supported callable, `render`.
