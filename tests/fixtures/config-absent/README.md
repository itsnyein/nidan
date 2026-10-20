# config-absent

**Proves:** a snapshot with no `tsconfig.json` and no `jsconfig.json` still produces
results, and says that it inferred a configuration.

Two things are asserted together on purpose, and they are two halves of one behavior:

- The run is **`degraded`**, not `failed`. A missing config reduces confidence; it does
  not stop the analysis.
- The run is degraded **for a stated reason**, `inferred-config`. A degraded status with
  no reason would be unactionable.

The seed and usage are still expected. Degraded means "trust this less", not "expect
less" — a reader who sees `degraded` and an empty result would draw the wrong conclusion.
