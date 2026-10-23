# AGENTS.md

## Project

nidan is a CLI that compares two Git refs in a JavaScript/TypeScript repository,
finds changed functions, and reports their direct usages with compiler evidence.
Correctness and explicit limitations matter more than feature count.

## Sources of truth

- Behavior — what nidan analyzes and outputs:
  `planning/spec/phase-1-technical-specification.md`
- Project and process — stack, structure, workflow, governance, testing, docs,
  release: `planning/decisions.md`
- Public documentation derived from the spec: `docs/`, with decision records in
  `docs/adr/` and the JSON output contract in `schema/`
- Progress: `planning/STATUS.md`
- Your task: the task prompt you were given. Do only what it asks.

`docs/`, `docs/adr/`, and `schema/` are created by later tasks; until then the spec
is the behavior source. If these rules conflict with the spec or
`planning/decisions.md`, stop and report. Do not reconcile silently.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Format check: `pnpm format:check`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Build: `pnpm build`
  All of these must pass before you report a task as done.

## Repository map

Planned layout. Directories are created by the task that first needs them.

- `src/cli/` argument parsing, exit codes, output writing (thin)
- `src/git/` ref validation, merge-base, diff, `ls-tree`, `cat-file`
- `src/project/` snapshot file system, config discovery, program loading
- `src/analysis/` seeds, identity, reference discovery, classification, gaps
- `src/report/` projection, JSON and text reporters
- `src/model.ts` result types matching the schema
- `src/index.ts` `analyze(options)` → Result. Never exits the process, never
  writes to stdout
- `tests/fixtures/<case>/` `base/`, `head/`, `expected.json`, `README.md`
- `tests/unit/`, `tests/integration/` test code
- `schema/` JSON Schema for the report
- `demo/` pinned demo config and generated reports
- `docs/`, `docs/adr/` public documentation and decision records
- `website/` documentation site (separate package)
- `CHANGELOG.md` curated at each release (T5.8)
- `planning/` private, Git-ignored: spec, decisions, status, prompts, handoffs,
  reviews

No `core/` directory. Directories map to pipeline stages. Approved fixtures under
`tests/fixtures/` are frozen.

## Engineering rules

- TypeScript strict mode. No `any`, non-null assertions, or type casts without
  a one-line justification comment.
- Keep module boundaries: `src/analysis` must not import from `src/cli`.
- Small, focused functions with meaningful names. Explicit error handling.
  Never swallow errors; unexpected states become typed errors or reported gaps.
- No abstraction without a current need. Extract shared code only on the
  third repetition. No interface with a single implementation unless it is
  a module boundary.
- No speculative features, options, or flags. No placeholder logic.
- Comments explain why: non-obvious reasoning, invariants, compiler quirks,
  security constraints. No comments that restate the code, no decorative or
  section-divider comments. Do not delete useful comments without a reason.
- Do not add, remove, or upgrade dependencies unless the task says so.
- Output must be deterministic: no timestamps, absolute paths, or
  locale-dependent ordering.
- Optimize only with a measurement showing the need.

## Testing rules

- Every behavior change needs a test that fails without the change.
- You may add or edit tests under `tests/unit/` and `tests/integration/`.
- Never modify anything under `tests/fixtures/` unless the task is an
  expectations task (ID starts with `E`). Approved fixtures are frozen.
- Never change production logic to special-case a test.
- Passing tests is necessary, not sufficient: show evidence for every
  acceptance criterion.

## Public contract

CLI flags, exit codes, the JSON schema, and documented supported patterns and
limitations are public. Changing them is a breaking change and requires
explicit approval in the task prompt. If you change public behavior, update
the matching docs in the same task.

## Permissions

Implementation agent:

- Edit only files allowed by the task prompt.
- Save the task prompt you received to
  `planning/prompts/tasks/<task-id>-<slug>.md` if it is not already there.
- Write your report to `planning/handoffs/<task-id>.md`.
- At the end of your task, update `planning/STATUS.md`: current milestone, task
  status, what changed, next task. Record facts only. Record the commit, branch,
  and pull request you created; mark review, approval, and merge as pending
  until the maintainer confirms them.

Review agent:

- Do not edit source, tests, fixtures, expectations, docs, or configs.
- Do not modify `planning/STATUS.md`.
- You may run tests and verification commands; generated or ignored
  artifacts are acceptable.
- Work through the review checklist in `planning/decisions.md` §7, in order:
  scope and integrity first, then verification, test meaningfulness,
  correctness against the spec, code quality, docs and decisions.
- Write your report to `planning/reviews/<task-id>.md`.

All agents:

- Git, allowed: read-only commands (`status`, `diff`, `log`, `show`), `checkout`,
  `pull --ff-only` on `main`, creating a working branch, committing, pushing that
  branch, rebasing a branch **that has not been pushed**, and opening a pull
  request for the current task.
- Git, forbidden: merging, force-pushing, rebasing or amending a commit that has
  been pushed, tagging, deleting branches, rewriting published history, bypassing
  branch protection or required checks, changing Git config or credential
  helpers, `gh auth setup-git`, and changing commit authorship.
- GitHub account, allowed: `gh auth switch -u Its-Nyein` when an operation on
  `itsnyein/nidan` needs it, verified with `gh auth status`, and pushing through
  the per-command credential helper. Do this without asking. The active account
  resets between shells, so expect to repeat it.

  Rebasing an unpushed branch is allowed because nothing downstream can depend on
  it yet. Once a branch is pushed its commits are published, and the forbidden
  list governs instead — the test is whether the commit has left this machine,
  not whether anyone has reviewed it.

- Work on a task branch, never directly on `main`. One task, one branch, one
  pull request. Name the branch for the change, not for the task: see
  "Planning labels stay in `planning/`". Maintainer-directed governance and configuration changes are the
  only exception (`planning/decisions.md` §9).
- Never merge your own pull request. The maintainer merges.

## Task loop

1. Work from the task prompt, the spec, and `planning/decisions.md`.
2. If the task needs golden expectations, the matching `E` task comes first and
   must be approved and merged by the maintainer before dependent tasks start.
3. Implement on a branch, within the files the prompt allows.
4. Run every command under Commands. Write the handoff and the review report.
   Update `planning/STATUS.md`.
5. Commit, push, open a pull request with the template filled in.
6. Blocking review findings get at most two fix rounds. If findings remain after
   the second round, stop: the task prompt is probably unclear.
7. The maintainer merges. Continue with the next task that does not depend on an
   unmerged pull request. If no task is unblocked, stop and list the pull
   requests waiting to be merged.

Task size is a reviewable diff: a few hundred lines of production code plus
tests. "Implement M3" is too big.

## Commit messages

Use one-line Conventional Commits in imperative mood (for example
`feat: add git snapshot loader`). Allowed types: `feat`, `fix`, `docs`, `test`,
`refactor`, `chore`, `ci`, `build`, `perf`, `style`, `revert`; optional scope;
optional `!`. Never add `Co-authored-by`, a session link, or any other AI
attribution.

Describe the change itself, never the plan it came from:
`feat: classify constructor references`.

## Planning labels stay in `planning/`

Milestone and task identifiers are internal planning labels. They appear only
inside `planning/`. Never put one in source code, comments, test names, fixture
names, `docs/`, ADRs, `schema/`, commit messages, pull request titles or bodies,
or branch names. A pull request body explains what changed and why in plain
terms, with no task identifier and no reference to `planning/`.

Branch names are `<type>/<short-meaningful-description>`, using the Conventional
Commit type: `feat/reference-discovery`, `test/barrel-usage-fixtures`,
`docs/attribution-rules`.

Existing code, fixtures, and history are left as they are.

## When to stop

Stop and set `Status: BLOCKED` in your report, with the specific question,
when expected behavior is unclear, the task conflicts with the spec, or
completing it requires touching files outside scope. Do not guess.

## Handoff report format

Status (DONE | BLOCKED), summary, files changed, commands run with output,
acceptance criteria with evidence for each, decisions not covered by the spec
(mark as ADR candidates), open questions, risks, suggested one-line
Conventional Commit message.

**For every new test, state why its input has the shape the test's name claims.** One
line per test is enough. This exists because the opposite failure has been common and is
invisible to a passing suite: a test whose assertion is correct but whose _input_ does not
reach the case it names — a "multi-declarator" input that is two separate statements, a
"mixed hunk" whose edits are on non-adjacent lines and so produce two hunks, a "siblings"
input whose declarations are on separate lines and so never contend. Each passed, and each
defended nothing. Mutation evidence is what catches this, so pair the two: the mutation
result proves the test can fail, and this line proves it fails for the stated reason.

## Review report format

One entry per finding: BLOCKING or NON-BLOCKING, `file:line`, problem,
suggestion. End with a verdict: APPROVE or CHANGES REQUESTED. Do not write
fixes.
