# ADR-0013: Every Git invocation is pinned, never inherited

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

nidan reads everything it analyzes through Git, so what Git says _is_ the input to
analysis. Git is configurable to a degree that makes this dangerous: the same two commits
can produce different output, or no output, depending on the machine.

A review of the diff module found four distinct routes, three of which were live defects:

- **`.gitattributes`.** `*.ts -diff` makes Git treat a text file as binary. A changed file
  then comes back with an **empty hunk list** — not an error, not a warning. It reads as
  "nothing changed here".
- **The environment.** `GIT_EXTERNAL_DIFF` names a program Git runs to produce the diff.
  Every changed file returns empty hunks, and an arbitrary program has been executed.
  `GIT_DIR` and `GIT_WORK_TREE` redirect Git at a different repository entirely.
- **Configuration.** `diff.interHunkContext` merges separate hunks, sweeping unchanged
  lines into the changed range. `diff.indentHeuristic` shifts hunk boundaries.
  `diff.algorithm` changes which lines are considered changed.
- **Pathspec matching.** A filename is a _pattern_ by default. A file literally named
  `foo[1].ts` is a character class that also matches `foo1.ts`, so one file's hunks arrive
  under another file's name.

Each produces a plausible-looking result. An empty hunk list is the worst: it violates the
no-silent-drops rule, and the only sign is an absence.

## Decision

**Every setting that can affect Git's output is pinned by an explicit flag, in one place
per command family, and never inherited.**

- `src/git/exec.ts` applies global options to every invocation — `--literal-pathspecs`,
  `--no-optional-locks`, `core.quotePath=false` — and **drops the entire `GIT_*`
  environment** from child processes.
- `src/git/diff.ts` is the only way nidan asks for a diff. It pins `--no-ext-diff`,
  `--no-textconv`, `--text`, `--no-color`, `--no-renames`, `--unified=0`,
  `--inter-hunk-context=0`, `--diff-algorithm=myers`, and `--no-indent-heuristic`.

The environment is dropped wholesale rather than by denylist. A denylist names the
variables that exist today, and Git keeps adding them.

A regression test accompanies each route, and **each was confirmed to fail when its flag
is removed**.

The algorithm route needed work to reach that bar. An obvious test — two isolated
substitutions in a nine-line file — produces identical hunks under all four algorithms, so
it passed with the pin removed and proved nothing. Input on which the algorithms actually
disagree had to be found by search rather than constructed by intuition: repeated lines
give the matchers more than one defensible alignment, and Myers then reports three hunks
where histogram and patience report two, covering different lines. That input is what the
test uses.

## Consequences

- The same two commits produce the same hunks on every machine, which is what the
  determinism guarantee requires of an input, not just of the report.
- nidan cannot be made to run a program through Git configuration or the environment,
  which A4 and A7 require.
- A project's own diff preferences are ignored. Someone who has configured
  `diff.algorithm=histogram` because they prefer its output will not see it reflected
  here. That is intended: nidan's output is a contract, not a rendering.
- New Git commands must be added through the shared helpers. A direct `execFile("git",
...)` would bypass every pin, which is why there is one entry point rather than a
  convention.
- The flag list needs revisiting when Git adds output-affecting settings. The regression
  tests are the thing that will catch it, by failing.

## Alternatives considered

**Set the configuration with `-c key=value` instead of flags.** Equivalent for settings
that have both forms. Rejected as the primary mechanism because flags are the documented
interface, are visible in the command, and cannot be silently overridden by a
higher-precedence source the way a `-c` can be by a command-line flag elsewhere.

**Deny-list the known-dangerous environment variables.** Smaller change, and preserves
anything legitimate in `GIT_*`. Rejected: nothing in `GIT_*` is legitimate for nidan —
every variable either redirects the repository or changes output — and a denylist silently
stops being complete when Git adds a variable.

**Run Git in a sandbox with no configuration at all** — `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1`, as the fixture harness does. Attractive, and it would close
user and system config in one move. Rejected for the analysis path because repository
config lives in `.git/config` and would still apply, so the flags are needed regardless;
adding the sandbox on top would suggest a completeness it does not provide. The harness
uses it because it is _building_ repositories, where the goal is a byte-identical commit
rather than a faithful read.

**Accept the inherited settings and document the variance.** Rejected outright: the
failure mode is a silently empty result, and no amount of documentation makes that safe.
