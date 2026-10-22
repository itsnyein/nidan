# seed-whitespace-only

**Proves:** a reformatting-only change produces no seed.

`total` is rewrapped across several lines. The token streams compare equal once whitespace
is removed, so it is not a seed and the expectation is empty.

This is the case that makes nidan usable after a formatter runs. Without the filter, a
Prettier upgrade would seed every callable in the repository and bury every real change.

Note this case also depends on the fixture harness hashing files from content: `calc.ts`
changes without changing length in some rewrappings, which is the shape that triggered
Git's racy index during T0.2.
