# manifest-changed

**Proves:** when `package.json` dependencies differ between the two refs, nidan warns and
names the changed packages, but the run stays `ok`.

`head/package.json` adds `ms`; `left-pad` is unchanged in both. Only `ms` is expected in
the warning — a warning that listed every dependency would be noise.

The status assertion is the point of the case. Dependencies are resolved from the working
tree rather than from either ref, so a manifest difference means the resolved types may
not match what either commit actually used. That is worth telling the user, and it is
_not_ worth degrading the run over: the analysis is still valid, just caveated. Status and
warnings are separate channels, and this case pins the distinction.

Neither package is installed in the fixture, and neither is imported by the source. The
case is about the manifest comparison alone.
