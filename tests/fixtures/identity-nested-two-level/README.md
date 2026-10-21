# identity-nested-two-level

**Proves:** a container chain with more than one level, and that `.` separates its parts.

Every earlier fixture has at most one container, so nothing pinned the separator. This
case fixes it deliberately rather than letting the first two-level fixture decide by
accident.

Two shapes, so the chain is exercised through both container kinds:

| Callable                          | Key                                                |
| --------------------------------- | -------------------------------------------------- |
| `inner` inside `Outer.run`        | `src/deep.ts :: Outer.run :: function :: inner`    |
| `inner` inside `outer` → `middle` | `src/deep.ts :: outer.middle :: function :: inner` |

The two `inner` functions are the point. They share a name, a file, and a kind; only the
chain tells them apart. A flattened chain, or one that kept just the nearest container,
would collapse them into one key and the case would report a collision instead of two
seeds.

Containers appear **outermost first**, matching how the path reads.

The usages differ on purpose: `values.map(inner)` is a `value-reference` — the function is
passed, not called — while `inner(value)` is an `invoke`. The same callable shape in two
positions should not produce the same relation.
