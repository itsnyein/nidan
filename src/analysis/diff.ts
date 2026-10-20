import { runDiff, runDiffNameStatus } from "../git/diff.js";
import { GitError } from "../git/errors.js";

/** Extensions omen analyzes. Anything else is counted and ignored. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

export type FileChange = "added" | "deleted" | "modified";

/**
 * A contiguous run of lines, as Git reports it.
 *
 * `count` is zero for one side of a pure insertion or deletion. That is not an empty
 * range to be discarded — it is the position the change happened at, and losing it would
 * lose the change.
 */
export interface LineRange {
  /** 1-based first line. For a zero-count range, the line the change sits after. */
  readonly start: number;
  readonly count: number;
}

export interface Hunk {
  readonly base: LineRange;
  readonly head: LineRange;
}

export interface FileDiff {
  /** Repository-relative POSIX path. For a deletion, the path in base. */
  readonly path: string;
  readonly change: FileChange;
  readonly hunks: readonly Hunk[];
}

export interface DiffResult {
  /** Changed JavaScript and TypeScript files, sorted by path. */
  readonly files: readonly FileDiff[];
  /**
   * How many changed files were not JavaScript or TypeScript. Counted rather than listed,
   * because the report says only how many were ignored.
   */
  readonly ignoredFileCount: number;
}

/**
 * Lists the changed source files between two commits, with the line ranges that changed.
 *
 * `--no-renames` is deliberate: a moved file is reported as a deletion plus an addition,
 * matching the documented identity model, where the path is part of a callable's key.
 * Letting Git detect the rename would produce a file-level match that the identity model
 * cannot honour, and the mismatch would surface as confusing results rather than as the
 * documented limitation.
 *
 * Every other output-affecting diff setting is pinned in `src/git/diff.ts`, so the same
 * two commits produce the same hunks regardless of attributes, config, or environment.
 */
export async function diffCommits(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<DiffResult> {
  const changed = await listChangedFiles(repoRoot, baseSha, headSha);

  const sourceFiles = changed.filter((file) => isSourceFile(file.path));
  const files = await Promise.all(
    sourceFiles.map(async (file) => ({
      path: file.path,
      change: file.change,
      hunks: await readHunks(repoRoot, baseSha, headSha, file.path),
    })),
  );

  return {
    files: files.sort((left, right) => (left.path < right.path ? -1 : 1)),
    ignoredFileCount: changed.length - sourceFiles.length,
  };
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The lines a range covers, or an empty array when the range is an insertion point. */
export function coveredLines(range: LineRange): number[] {
  return Array.from({ length: range.count }, (_, index) => range.start + index);
}

/** Whether a 1-based line falls inside a range. A zero-count range covers no line. */
export function covers(range: LineRange, line: number): boolean {
  return (
    range.count > 0 && line >= range.start && line < range.start + range.count
  );
}

/**
 * Whether a range overlaps an inclusive span, such as a callable's line extent.
 *
 * A zero-count range still overlaps: an insertion between two lines of a function body
 * changed that function, and treating the range as empty would drop the change silently.
 * The insertion point sits after `start`, so it touches a span that contains either
 * `start` or the following line.
 */
export function overlapsSpan(
  range: LineRange,
  spanStart: number,
  spanEnd: number,
): boolean {
  if (range.count === 0) {
    return spanStart <= range.start + 1 && range.start <= spanEnd;
  }
  return range.start <= spanEnd && range.start + range.count - 1 >= spanStart;
}

interface ChangedFile {
  readonly path: string;
  readonly change: FileChange;
}

/**
 * `--name-status -z` gives status and path as NUL-separated fields, so a path containing
 * a space, a quote, or a newline needs no unquoting. Parsing paths out of the diff body
 * instead would have to handle Git's own quoting rules.
 */
async function listChangedFiles(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<ChangedFile[]> {
  const { stdout } = await runDiffNameStatus(repoRoot, [
    "--end-of-options",
    baseSha,
    headSha,
  ]);

  const fields = stdout.split("\0").filter((field) => field !== "");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) continue;
    files.push({ path, change: toFileChange(status, path) });
  }
  return files;
}

function toFileChange(status: string, path: string): FileChange {
  // Only the first letter matters; a similarity score may follow it.
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
      return "modified";
    default:
      throw new GitError(
        "command-failed",
        `unexpected diff status "${status}" for ${path}`,
      );
  }
}

/**
 * Reads the hunks for one file.
 *
 * One Git invocation per changed file, rather than one parse of a combined diff. The
 * combined form would mean recovering each hunk's file from `diff --git` headers, which
 * carry Git's path quoting; asking per file removes that parsing entirely. A diff touches
 * few files, and correctness comes before a process count that has not been measured.
 */
async function readHunks(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  path: string,
): Promise<Hunk[]> {
  // Every output-affecting setting is pinned by runDiff; see src/git/diff.ts. The path
  // after `--` is matched literally, because runGit passes --literal-pathspecs.
  const { stdout } = await runDiff(repoRoot, [
    "--end-of-options",
    baseSha,
    headSha,
    "--",
    path,
  ]);

  const hunks: Hunk[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("@@")) continue;
    hunks.push(parseHunkHeader(line, path));
  }
  return hunks;
}

/** `@@ -<start>[,<count>] +<start>[,<count>] @@ [context]` */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string, path: string): Hunk {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    throw new GitError(
      "command-failed",
      `unparsable hunk header for ${path}: ${line}`,
    );
  }

  // A missing count means one line, which is Git's shorthand.
  return {
    base: {
      start: Number(match[1]),
      count: match[2] === undefined ? 1 : Number(match[2]),
    },
    head: {
      start: Number(match[3]),
      count: match[4] === undefined ? 1 : Number(match[4]),
    },
  };
}
