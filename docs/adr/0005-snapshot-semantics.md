# ADR-0005: Sources from Git objects, dependencies from the working tree

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Analyzing two refs means having two source trees available to a type checker at once.

Checking out each ref is the obvious approach and is unacceptable: it mutates the user's
working tree, destroys uncommitted work, and makes running omen a dangerous thing to do
mid-task. Cloning to a temporary directory avoids that but copies the repository twice and
still leaves dependencies unresolved — `node_modules` is not committed, so a checked-out
snapshot has no types for any import.

There is also a correctness trap. If snapshot reads fall back to disk when a path is
missing from the Git tree, the working tree leaks into results: an uncommitted edit silently
changes what omen reports about a committed ref.

## Decision

Repository source files are read **only from Git objects**, through `git ls-tree` and
`git cat-file --batch`, served to the compiler through a virtual file system. There is no
disk fallback: a path inside the repository that is not in the snapshot is not found.

Dependencies are the deliberate exception. `<repo>/node_modules/**` is read from the real
working tree, read-only, with `realpath` resolution so pnpm's symlinked layout works.

Virtual paths equal the repository's real absolute paths, so TypeScript's resolver walks
up to `node_modules` naturally instead of needing a rewritten resolution algorithm.

The working tree is never written to.

## Consequences

- omen is safe to run at any time, including mid-edit, with no checkout and no clone.
- Results describe the refs that were asked about. Uncommitted edits and untracked files
  are invisible — which is the point, and is why a leak test is part of the acceptance
  criteria.
- Dependency types resolve without installing anything, because the working tree already
  has them.
- Dependencies come from _now_, not from the compared refs. Analyzing an old ref uses
  today's packages, so historical dependency accuracy is not guaranteed. This is stated in
  the coverage statement rather than hidden.
- A manifest or lockfile difference between the refs produces a warning naming the changed
  packages, but does not degrade the run — the analysis is still valid, just caveated.
- Missing `node_modules` degrades the run with a `dependencies-not-installed` reason
  rather than failing it.
- Symlinks and submodules inside a snapshot are skipped and counted, because a Git tree
  entry for a symlink is a path string, not a file.
- omen never installs dependencies, never reaches the network, never runs lifecycle
  scripts, and never executes repository code.

## Alternatives considered

**Check out each ref.** Rejected: mutates the working tree and can destroy uncommitted
work. Unacceptable for a tool meant to be run casually.

**Clone to a temporary directory.** Safe for the working tree. Rejected because it doubles
disk use and copy time per run, and still leaves dependencies unresolved — the temporary
clone has no `node_modules`, so every import of a package would be unresolved.

**`git worktree add`.** Cheaper than a clone and leaves the main working tree alone.
Rejected for the same dependency problem, plus it writes to the user's repository
administrative state.

**Disk fallback when a path is missing from the snapshot.** Would make missing files
"just work". Rejected because it is exactly the leak this design exists to prevent: it
makes results depend on uncommitted state in a way the user cannot see.
