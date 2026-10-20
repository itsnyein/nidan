# identity-constructor

**Proves:** a changed constructor is resolved through its class symbol, with the
`construct` relation.

`Client`'s constructor gains a guard. Key:

```
src/client.ts :: Client :: constructor :: constructor
```

Two usages, and they are different shapes:

- `new Client(...)` in `use.ts`, the ordinary case.
- `super(url)` inside `RetryingClient`'s constructor, in the **same file**. A subclass
  calling `super()` is a construction of the base class, and an implementation that only
  looked for `new` would miss it entirely.

The `from` of the `super()` usage is the subclass constructor, which is itself a supported
callable.
