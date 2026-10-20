# config-jsconfig-paths

**Proves:** `baseUrl` and `paths` from `jsconfig.json` are honored, so an aliased import
resolves to the same symbol a relative import would.

`src/page.js` imports `@/lib/slug.js`. If the alias were not applied, the specifier would
not resolve and the case would show an `unresolved-module` gap and no usage — which is why
`repoWideGaps` is asserted empty rather than left unmentioned. The empty list is the
assertion here, not a formality.

This case is `.js` throughout, with `checkJs`, so it also covers the JavaScript half of
the supported file types under a `jsconfig` rather than a `tsconfig`.
