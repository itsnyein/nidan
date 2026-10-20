# ADR-0010: Prettier formats governance Markdown

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

`AGENTS.md`, `CLAUDE.md`, and the pull request template are instruction files. Their
wording is specified, and an agent follows them literally, so they were initially excluded
from Prettier on the grounds that they must be kept verbatim.

That reading conflated two different things. "Verbatim" is a claim about **content** —
which words, in which order, with which meaning. Prettier changes **whitespace**: line
wrapping, list indentation, table padding. It does not change words.

The exclusion had a real cost. These files are the ones most often edited by agents, and
they were the only Markdown in the repository with no formatting check, so they drifted.

## Decision

Prettier formats `AGENTS.md`, `CLAUDE.md`, and `.github/pull_request_template.md` along
with all other Markdown. They are not listed in `.prettierignore`.

"Verbatim" means content, not whitespace. A change that alters a word, a list item, an
ordering, or a meaning is a content change and needs review on its merits. A change that
only rewraps is formatting.

When the exclusion was lifted, the three files were compared word by word to confirm that
nothing but whitespace had changed.

## Consequences

- Every Markdown file in the repository is covered by one formatting check, enforced in
  CI.
- Diffs on governance files show content changes rather than whitespace churn.
- Prettier's output is now the reference form. Reflowing a paragraph after an edit is
  expected and is not a content change.
- A Prettier version bump can reflow these files. That is a formatting-only diff, and the
  word-level comparison is the check if it is ever in doubt.
- **Fenced code examples are formatted too**, which bites: an example must be valid
  standalone code in its fence's language. A bare JSX attribute in a `ts` fence was
  silently rewritten into an assignment, changing its meaning, before being caught in
  review.

## Alternatives considered

**Keep the exclusion.** Preserves byte-for-byte stability. Rejected because it protects
the wrong thing — whitespace — while leaving the files with no formatting check at all.

**Exclude only fenced code blocks.** Would avoid the example-rewriting hazard. Rejected:
Prettier has no such option, and the hazard is better handled by writing valid examples,
which is a property worth having anyway.
