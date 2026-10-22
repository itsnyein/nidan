import { GitError } from "./errors.js";
import { assertUsableRef, runGit } from "./exec.js";

/** Resolves the repository root containing `cwd`. */
export async function findRepositoryRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch (error) {
    throw new GitError(
      "not-a-repository",
      `${cwd} is not inside a Git repository`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Resolves a ref to the SHA of the commit it names.
 *
 * `^{commit}` dereferences annotated tags, so a tag and the branch at the same place
 * resolve identically. `--end-of-options` guarantees the ref is read as a revision even
 * if it somehow reaches here looking like an option.
 */
export async function resolveCommit(
  repoRoot: string,
  ref: string,
): Promise<string> {
  assertUsableRef(ref);
  try {
    const { stdout } = await runGit(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    const sha = stdout.trim();
    if (sha === "") {
      throw new GitError(
        "unknown-ref",
        `ref "${ref}" does not resolve to a commit`,
      );
    }
    return sha;
  } catch (error) {
    if (error instanceof GitError && error.kind !== "command-failed") {
      throw error;
    }
    // `--quiet` makes rev-parse exit non-zero with no output when the ref is unknown,
    // which is the shallow-clone case and is the user's problem, not a tool failure.
    throw new GitError(
      "unknown-ref",
      `ref "${ref}" does not resolve to a commit`,
      {
        cause: error,
      },
    );
  }
}

/**
 * The best common ancestor of two commits.
 *
 * nidan compares `merge-base(base, head)` against `head` so that a report shows what the
 * head branch changed, not what the base branch moved on to — the same diff a pull
 * request shows.
 */
export async function findMergeBase(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(repoRoot, [
      "merge-base",
      "--end-of-options",
      baseSha,
      headSha,
    ]);
    const sha = stdout.trim();
    if (sha === "") {
      throw new GitError(
        "unknown-ref",
        `no common ancestor between ${baseSha} and ${headSha}`,
      );
    }
    return sha;
  } catch (error) {
    if (error instanceof GitError && error.kind !== "command-failed") {
      throw error;
    }
    // merge-base exits 1 when the histories are unrelated, which a shallow clone also
    // produces because the common ancestor was never fetched.
    throw new GitError(
      "unknown-ref",
      `no common ancestor between ${baseSha} and ${headSha}; the repository may be a shallow clone`,
      { cause: error },
    );
  }
}
