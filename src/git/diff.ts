import { runGit, type GitResult } from "./exec.js";

/**
 * Flags that pin every output-affecting diff setting.
 *
 * A diff is an input to analysis, so the same two commits must produce the same hunks on
 * every machine. Git disagrees by default: `.gitattributes`, user, system, and repository
 * config, and the environment can each change what a diff says, or have an external
 * program say it instead. Each flag below closes one of those routes, and the set is kept
 * in one place so no caller can assemble a diff that misses one.
 *
 * | Flag | Closes |
 * | --- | --- |
 * | `--no-ext-diff` | `diff.external`, and per-attribute external drivers |
 * | `--no-textconv` | `textconv` filters that replace source with rendered text |
 * | `--text` | the `-diff` attribute, which makes a text file report as binary with **no hunks at all** |
 * | `--no-color` | colour codes in the hunk headers |
 * | `--no-renames` | `diff.renames`; a move must read as a delete plus an add |
 * | `--unified=0` | `diff.context` |
 * | `--inter-hunk-context=0` | `diff.interHunkContext`, which merges separate hunks and sweeps unchanged lines into the changed range |
 * | `--diff-algorithm=myers` | `diff.algorithm`; algorithms disagree about which lines changed |
 * | `--no-indent-heuristic` | `diff.indentHeuristic`, which shifts hunk boundaries |
 *
 * The `-diff` attribute and `GIT_EXTERNAL_DIFF` are the dangerous two: both make omen
 * report a changed file with an empty hunk list, which reads as "nothing changed here"
 * rather than as a failure. That is a silent drop, which the core guarantee forbids.
 */
const PINNED_DIFF_FLAGS: readonly string[] = [
  "--no-ext-diff",
  "--no-textconv",
  "--text",
  "--no-color",
  "--no-renames",
  "--unified=0",
  "--inter-hunk-context=0",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
];

/**
 * Runs `git diff` with every output-affecting setting pinned.
 *
 * This is the only way omen asks Git for a diff. `runGit` additionally drops the `GIT_*`
 * environment, which is where `GIT_EXTERNAL_DIFF` and `GIT_DIFF_OPTS` would otherwise
 * arrive.
 */
export async function runDiff(
  cwd: string,
  args: readonly string[],
): Promise<GitResult> {
  return runGit(cwd, ["diff", ...PINNED_DIFF_FLAGS, ...args]);
}

/**
 * Runs a diff query that reports names and statuses rather than patch text. Takes the
 * pathspec and rename settings but not the patch-shaping flags, which Git rejects here.
 */
export async function runDiffNameStatus(
  cwd: string,
  args: readonly string[],
): Promise<GitResult> {
  return runGit(cwd, ["diff", "--no-renames", "--name-status", "-z", ...args]);
}
