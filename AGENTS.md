# AGENTS.md

## Project

omen is a CLI that compares two Git refs in a JavaScript/TypeScript repository,
finds changed functions, and reports their direct usages with compiler evidence.
Correctness and explicit limitations matter more than feature count.

## Sources of truth

- Behavior spec, supported patterns, limitations: `docs/`
- Decisions: `docs/adr/`
- JSON output contract: `schema/`
- Your task: the task prompt you were given. Do only what it asks.
- `planning/STATUS.md` is the project status record.
  Some of these locations are created by later tasks. If a source you need does not
  exist yet, rely on your task prompt.

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
- `src/git/` ref validation, diff, reading files from Git objects
- `src/project/` snapshot file system, config discovery, program loading
- `src/analysis/` seeds, identity, reference discovery, classification, gaps
- `src/report/` projection, JSON and text reporters
- `tests/unit/`, `tests/integration/` test code
- `tests/fixtures/` approved fixtures and golden expectations (frozen)
- `docs/`, `docs/adr/` public documentation and decisions
- `schema/` JSON Schema for the report
- `website/` documentation site (separate package)
- `planning/` private, Git-ignored planning, prompts, handoffs, reviews

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
- Write your report to `planning/reviews/<task-id>.md`.

All agents:

- Git, allowed: read-only commands (`status`, `diff`, `log`, `show`), creating a
  working branch, committing, pushing that branch, and opening a draft pull
  request for the current task.
- Git, forbidden: merging, force-pushing, tagging, deleting branches, rewriting
  history, bypassing branch protection or required checks, and changing commit
  authorship.
- Work on a task branch, never directly on `main`. One task, one branch, one
  pull request.
- Never merge your own pull request. The maintainer merges.

## Commit messages

Use one-line Conventional Commits in imperative mood (for example
`feat: add git snapshot loader`). Never add `Co-authored-by`, a session link, or
any other AI attribution.

## When to stop

Stop and set `Status: BLOCKED` in your report, with the specific question,
when expected behavior is unclear, the task conflicts with the spec, or
completing it requires touching files outside scope. Do not guess.

## Handoff report format

Status (DONE | BLOCKED), summary, files changed, commands run with output,
acceptance criteria with evidence for each, decisions not covered by the spec
(mark as ADR candidates), open questions, risks, suggested one-line
Conventional Commit message.

## Review report format

One entry per finding: BLOCKING or NON-BLOCKING, `file:line`, problem,
suggestion. End with a verdict: APPROVE or CHANGES REQUESTED. Do not write
fixes.
