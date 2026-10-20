# seed-added-deleted

**Proves:** added, deleted, and untouched callables are classified correctly in one diff,
and each is seeded from the right snapshot.

| Callable  | Base    | Head               | Expected                    |
| --------- | ------- | ------------------ | --------------------------- |
| `kept`    | present | present, unchanged | **no seed**                 |
| `removed` | present | absent             | `deleted`, seeded from base |
| `added`   | absent  | present            | `added`, seeded from head   |

The snapshot each seed comes from is the part worth checking: a deleted callable only
exists in base, so an implementation that always read head would find nothing and report
the deletion as no change at all.

`kept` is in the case so that "seeds everything in a changed file" fails here.
