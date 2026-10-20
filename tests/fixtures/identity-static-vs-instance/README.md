# identity-static-vs-instance

**Proves:** the trailing `static` marker is what separates a static and an instance method
sharing a name.

`Registry` has both `static create()` and `create()`. Only the instance method changes.
Keys:

```
src/registry.ts :: Registry :: method :: create            <- seeded (instance)
src/registry.ts :: Registry :: method :: create :: static  <- unchanged
```

Without the marker these collide, and the case reports an `ambiguous-identity` gap instead
of a seed. With it, changing one must not seed the other — a static factory and an
instance method are unrelated code that happens to share a name.
