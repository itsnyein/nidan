# seed-comment-change

**Proves:** a comment change inside a callable **is** a modification.

Only the JSDoc on `total` changes. The body is untouched, so the expectation is a seed with
`change: modified`.

This is the deliberate counterpart to `seed-whitespace-only`, and the pair is the point:
whitespace is noise, comments are not. A JSDoc line can state a contract, a unit, or a
caveat that callers rely on, and a documentation change that silently produced no result
would be a wrong answer rather than a quiet one.

Comments sit inside the callable's full range, which also covers decorators and the
signature.
