import { GitError } from "./errors.js";
import { runGit } from "./exec.js";

/** Git's file modes, as they appear in a tree listing. */
export const FILE_MODE = {
  regular: "100644",
  executable: "100755",
  symlink: "120000",
  submodule: "160000",
} as const;

export interface TreeEntry {
  /** One of {@link FILE_MODE}. */
  readonly mode: string;
  /** `commit` marks a submodule; its object lives in another repository. */
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  /** Repository-relative POSIX path. Git stores paths this way on every platform. */
  readonly path: string;
}

/**
 * Lists every entry reachable from a commit, recursively.
 *
 * Symlinks and submodules are returned rather than filtered: callers decide what to do
 * with them, and the run needs to report how many were skipped.
 */
export async function listTree(
  repoRoot: string,
  commitSha: string,
): Promise<TreeEntry[]> {
  // -z terminates each record with NUL, which is the only safe separator: a path may
  // contain a newline, and without -z Git would also quote non-ASCII paths.
  const { stdout } = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "--end-of-options",
    commitSha,
  ]);

  const records = stdout.split("\0").filter((record) => record !== "");
  return records.map((record) => parseTreeRecord(record, commitSha));
}

/** `<mode> SP <type> SP <oid> TAB <path>` */
function parseTreeRecord(record: string, commitSha: string): TreeEntry {
  const tabIndex = record.indexOf("\t");
  if (tabIndex === -1) {
    throw new GitError(
      "command-failed",
      `unparsable ls-tree record for ${commitSha}: ${record}`,
    );
  }

  const path = record.slice(tabIndex + 1);
  const fields = record.slice(0, tabIndex).split(" ");
  const [mode, type, oid] = fields;
  if (
    fields.length !== 3 ||
    mode === undefined ||
    type === undefined ||
    oid === undefined
  ) {
    throw new GitError(
      "command-failed",
      `unparsable ls-tree record for ${commitSha}: ${record}`,
    );
  }
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw new GitError(
      "command-failed",
      `unknown ls-tree object type "${type}" for ${path}`,
    );
  }

  return { mode, type, oid, path };
}

export function isSymlink(entry: TreeEntry): boolean {
  return entry.mode === FILE_MODE.symlink;
}

export function isSubmodule(entry: TreeEntry): boolean {
  return entry.type === "commit";
}
