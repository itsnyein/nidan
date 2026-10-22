# ADR-0011: Repository-local noreply commit email

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

The first push to `itsnyein/nidan` was rejected:

```
GH007: Your push would publish a private email address
```

Both existing commits were authored with a personal address, and the account that owns the
repository has email privacy enabled. The maintainer also uses more than one GitHub
account on this machine, so the globally configured Git identity is not the right one for
this repository.

Changing global Git config to fix one repository would silently re-identify every other
repository on the machine.

## Decision

`user.email` is set **repository-locally** to the owning account's GitHub-provided noreply
address:

```
git config --local user.email <id>+<account>@users.noreply.github.com
```

Global and system Git configuration are never modified, and `user.name` is left unchanged.

The two existing commits were rewritten to carry the new address. This was safe
specifically because the remote had no refs yet, so no published history was rewritten and
no force push was involved. Their tree hashes and messages were verified byte-identical
afterwards.

Agents may not change Git configuration or authorship. This setting is maintainer-applied
and is recorded here so it is not mistaken for drift.

## Consequences

- Pushes succeed with email privacy on, and no private address is published.
- Commits are attributed to the correct account, while other repositories on the machine
  keep the global identity.
- The setting is invisible in a fresh clone. Anyone who re-clones must reapply it, or
  their first push will be rejected the same way.
- Authorship is now a thing to verify after any history operation, which is why it is
  checked explicitly rather than assumed.

## Alternatives considered

**Disable email privacy on the account.** One click. Rejected: it publishes a personal
address in every commit of every public repository, to fix one repository.

**Change the global Git identity.** Rejected: it re-identifies every repository on the
machine as a side effect of configuring one.

**Leave the original address and push to a different account.** Rejected — the repository
belongs where it is, and this would trade a configuration problem for an ownership one.

**Rewrite history later, after pushing.** Not available: once refs are published, this
becomes a force push over shared history, which is forbidden.
