/**
 * Path helpers for the snapshot file system.
 *
 * Every path crossing this boundary is an absolute POSIX-style path. Git stores paths
 * with forward slashes on every platform and the TypeScript compiler normalizes to
 * forward slashes internally, so using one spelling throughout removes a whole class of
 * Windows-only comparison bugs.
 */

/** Converts Windows separators to forward slashes and drops any trailing slash. */
export function toPosixPath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  return forward.length > 1 && forward.endsWith("/")
    ? forward.slice(0, -1)
    : forward;
}

/** Joins an absolute POSIX directory with a repository-relative POSIX path. */
export function joinPosix(directory: string, relative: string): string {
  const base = toPosixPath(directory);
  return relative === "" ? base : `${base}/${relative}`;
}

/**
 * True when `path` is `directory` itself or sits beneath it.
 *
 * The separator check matters: without it `/repo/node_modules_old` would be treated as
 * living inside `/repo/node_modules`.
 */
export function isWithin(directory: string, path: string): boolean {
  const base = toPosixPath(directory);
  const candidate = toPosixPath(path);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/** The parent of an absolute POSIX path, or the path itself at the root. */
export function parentOf(path: string): string {
  const normalized = toPosixPath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized;
  return normalized.slice(0, index);
}

/**
 * Every ancestor directory of a path, nearest last, stopping at `stopAt`.
 * Used to build the set of directories a snapshot contains.
 */
export function ancestorsWithin(stopAt: string, path: string): string[] {
  const root = toPosixPath(stopAt);
  const ancestors: string[] = [];
  let current = parentOf(path);
  while (isWithin(root, current) && current !== root) {
    ancestors.push(current);
    const next = parentOf(current);
    if (next === current) break;
    current = next;
  }
  ancestors.push(root);
  return ancestors;
}
