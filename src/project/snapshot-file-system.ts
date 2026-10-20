import {
  existsSync,
  readFileSync as readDiskFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";

import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

import { openBlobReader } from "../git/blobs.js";
import { isSubmodule, isSymlink, listTree } from "../git/tree.js";
import {
  ancestorsWithin,
  isWithin,
  joinPosix,
  parentOf,
  toPosixPath,
} from "./paths.js";

const NODE_MODULES = "node_modules";

export class SnapshotFileSystemError extends Error {
  override readonly name = "SnapshotFileSystemError";
}

/** Entries a snapshot cannot represent, reported so a run can say what it skipped. */
export interface SkippedEntries {
  readonly symlinks: readonly string[];
  readonly submodules: readonly string[];
}

export interface SnapshotFileSystem {
  readonly host: FileSystemHost;
  readonly skipped: SkippedEntries;
  /** Repository-relative POSIX paths of every file the snapshot serves. */
  readonly files: readonly string[];
}

export interface SnapshotFileSystemOptions {
  /** Absolute path to the repository working directory. */
  readonly repoRoot: string;
  /** The commit whose tree this snapshot serves. */
  readonly commitSha: string;
  /**
   * Absolute directories outside the repository that may still be read from disk — in
   * practice only omen's own bundled TypeScript `lib.*.d.ts` folder. Everything else
   * outside the repository is denied.
   */
  readonly externalReadRoots?: readonly string[];
}

/**
 * Builds a read-only file system that serves a Git commit's source to the TypeScript
 * compiler, while routing dependency reads to the real working tree.
 *
 * Virtual paths are the repository's real absolute paths, so the compiler's resolver
 * walks up to `node_modules` by itself instead of needing a rewritten algorithm.
 *
 * Blobs are read eagerly into memory. The compiler's file access is synchronous while
 * Git's is not, and a full program reads essentially every source file anyway, so
 * pre-loading trades memory for a correct synchronous surface. Whether that cost is worth
 * optimizing is a question for the performance baseline, not a guess made here.
 */
export async function createSnapshotFileSystem(
  options: SnapshotFileSystemOptions,
): Promise<SnapshotFileSystem> {
  const givenRoot = toPosixPath(options.repoRoot);
  // The repository may be reached through a symlinked path — /var is a link to
  // /private/var on macOS, and temporary directories live under it. `realpathSync` on a
  // dependency then returns a path under the resolved root, which would fall outside the
  // given root and be denied. Both spellings are therefore accepted, and the resolved one
  // is canonical.
  const repoRoot = resolveRealPath(givenRoot);
  const externalReadRoots = (options.externalReadRoots ?? []).flatMap(
    (root) => {
      const given = toPosixPath(root);
      const resolved = resolveRealPath(given);
      return given === resolved ? [given] : [given, resolved];
    },
  );

  const entries = await listTree(options.repoRoot, options.commitSha);
  const symlinks: string[] = [];
  const submodules: string[] = [];
  const blobs: Array<{ path: string; oid: string }> = [];

  for (const entry of entries) {
    if (isSubmodule(entry)) {
      // A submodule's objects live in another repository; this one cannot resolve them.
      submodules.push(entry.path);
    } else if (isSymlink(entry)) {
      // A symlink's blob is its target path, not file content. Following it would mean
      // inventing resolution rules Git does not apply to a tree.
      symlinks.push(entry.path);
    } else if (entry.type === "blob") {
      blobs.push({ path: entry.path, oid: entry.oid });
    }
  }

  const contents = await readBlobs(options.repoRoot, blobs);
  const files = new Map<string, string>();
  const directories = new Set<string>([repoRoot]);
  for (const [relativePath, text] of contents) {
    const absolute = joinPosix(repoRoot, relativePath);
    files.set(absolute, text);
    for (const ancestor of ancestorsWithin(repoRoot, absolute)) {
      directories.add(ancestor);
    }
  }

  const host = new SnapshotHost({
    repoRoot,
    givenRoot,
    externalReadRoots,
    files,
    directories,
  });

  return {
    host,
    skipped: { symlinks, submodules },
    files: [...contents.keys()],
  };
}

async function readBlobs(
  repoRoot: string,
  blobs: readonly { path: string; oid: string }[],
): Promise<Map<string, string>> {
  const reader = openBlobReader(repoRoot);
  try {
    const texts = await Promise.all(
      blobs.map(
        async (blob) =>
          [blob.path, normalizeNewlines(await reader.read(blob.oid))] as const,
      ),
    );
    return new Map(texts);
  } finally {
    await reader.close();
  }
}

/**
 * Normalizes CRLF to LF on read.
 *
 * A repository checked out on Windows and one checked out on Linux must produce the same
 * analysis, and the same report. Normalizing here rather than in the Git layer keeps blob
 * reads faithful to the stored object.
 */
function normalizeNewlines(contents: Buffer): string {
  return contents.toString("utf8").replace(/\r\n/g, "\n");
}

function resolveRealPath(path: string): string {
  try {
    return toPosixPath(realpathSync.native(path));
  } catch {
    // The path need not exist yet; callers still compare against it.
    return path;
  }
}

interface SnapshotHostState {
  /** Canonical root, with any symlinks in the path resolved. */
  readonly repoRoot: string;
  /** The root as the caller spelled it, accepted as an alias. */
  readonly givenRoot: string;
  readonly externalReadRoots: readonly string[];
  readonly files: ReadonlyMap<string, string>;
  readonly directories: ReadonlySet<string>;
}

/** Where a path is served from. */
type Route = "snapshot" | "disk" | "denied";

class SnapshotHost implements FileSystemHost {
  constructor(private readonly state: SnapshotHostState) {}

  /**
   * Decides where a path is served from. This is the whole isolation guarantee in one
   * function, so it is kept deliberately small and total.
   */
  /**
   * Rewrites a path spelled with the caller's root onto the canonical root, so both
   * spellings address the same snapshot entry.
   */
  private canonical(path: string): string {
    const normalized = toPosixPath(path);
    const { repoRoot, givenRoot } = this.state;
    if (givenRoot !== repoRoot && isWithin(givenRoot, normalized)) {
      return `${repoRoot}${normalized.slice(givenRoot.length)}`;
    }
    return normalized;
  }

  private route(path: string): Route {
    const normalized = this.canonical(path);
    const { repoRoot, externalReadRoots } = this.state;

    if (isWithin(joinPosix(repoRoot, NODE_MODULES), normalized)) {
      // Dependencies are not in the snapshot — they are never committed — so they come
      // from the working tree.
      return "disk";
    }
    if (isWithin(repoRoot, normalized)) {
      // Repository source: snapshot only. There is deliberately no disk fallback, because
      // one would let an uncommitted edit silently change what omen reports about a ref.
      return "snapshot";
    }
    if (externalReadRoots.some((root) => isWithin(root, normalized))) {
      return "disk";
    }
    return "denied";
  }

  isCaseSensitive(): boolean {
    // Reporting case-sensitive keeps lookups exact. A repository whose paths differ only
    // by case would otherwise resolve differently per platform, breaking determinism.
    return true;
  }

  getCurrentDirectory(): string {
    return this.state.repoRoot;
  }

  readFileSync(filePath: string): string {
    const normalized = this.canonical(filePath);
    switch (this.route(normalized)) {
      case "snapshot": {
        const contents = this.state.files.get(normalized);
        if (contents === undefined) {
          throw new SnapshotFileSystemError(
            `${normalized} is not in this snapshot`,
          );
        }
        return contents;
      }
      case "disk":
        return normalizeNewlines(readDiskFileSync(normalized));
      case "denied":
        throw new SnapshotFileSystemError(
          `${normalized} is outside the repository and is not readable`,
        );
    }
  }

  readFile(filePath: string): Promise<string> {
    return Promise.resolve(this.readFileSync(filePath));
  }

  fileExistsSync(filePath: string): boolean {
    const normalized = this.canonical(filePath);
    switch (this.route(normalized)) {
      case "snapshot":
        return this.state.files.has(normalized);
      case "disk":
        return existsSync(normalized) && statSync(normalized).isFile();
      case "denied":
        return false;
    }
  }

  fileExists(filePath: string): Promise<boolean> {
    return Promise.resolve(this.fileExistsSync(filePath));
  }

  directoryExistsSync(dirPath: string): boolean {
    const normalized = this.canonical(dirPath);
    switch (this.route(normalized)) {
      case "snapshot":
        return this.state.directories.has(normalized);
      case "disk":
        return existsSync(normalized) && statSync(normalized).isDirectory();
      case "denied":
        return false;
    }
  }

  directoryExists(dirPath: string): Promise<boolean> {
    return Promise.resolve(this.directoryExistsSync(dirPath));
  }

  readDirSync(dirPath: string): RuntimeDirEntry[] {
    const normalized = this.canonical(dirPath);
    switch (this.route(normalized)) {
      case "snapshot":
        return this.readSnapshotDir(normalized);
      case "disk":
        return readdirSync(normalized, { withFileTypes: true }).map(
          (entry) => ({
            name: joinPosix(normalized, entry.name),
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink(),
          }),
        );
      case "denied":
        return [];
    }
  }

  private readSnapshotDir(dirPath: string): RuntimeDirEntry[] {
    const seen = new Map<string, RuntimeDirEntry>();
    for (const filePath of this.state.files.keys()) {
      if (parentOf(filePath) === dirPath) {
        seen.set(filePath, {
          name: filePath,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        });
      }
    }
    for (const directory of this.state.directories) {
      if (parentOf(directory) === dirPath && directory !== dirPath) {
        seen.set(directory, {
          name: directory,
          isFile: false,
          isDirectory: true,
          isSymlink: false,
        });
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
  }

  realpathSync(path: string): string {
    const normalized = this.canonical(path);
    if (this.route(normalized) === "disk") {
      // pnpm installs a package once under `.pnpm` and links to it. Resolving the link is
      // what lets the compiler find a package's own dependencies, which sit beside the
      // real directory rather than beside the link.
      return resolveRealPath(normalized);
    }
    // Snapshot paths are virtual: there is nothing on disk to resolve, and resolving
    // would risk escaping into the working tree.
    return normalized;
  }

  glob(patterns: readonly string[]): Promise<string[]> {
    return Promise.resolve(this.globSync(patterns));
  }

  globSync(patterns: readonly string[]): string[] {
    // Patterns come from tsconfig and are spelled with the caller's root, so they need
    // the same rewrite as a path before they can match the canonical file keys.
    const matchers = patterns.map((pattern) =>
      toMatcher(
        pattern.startsWith("!")
          ? `!${this.canonical(pattern.slice(1))}`
          : this.canonical(pattern),
      ),
    );
    const include = matchers.filter((matcher) => !matcher.negated);
    const exclude = matchers.filter((matcher) => matcher.negated);
    return [...this.state.files.keys()]
      .filter(
        (path) =>
          include.some((matcher) => matcher.test(path)) &&
          !exclude.some((matcher) => matcher.test(path)),
      )
      .sort();
  }

  delete(): Promise<void> {
    return Promise.reject(this.readOnly("delete"));
  }

  deleteSync(): void {
    throw this.readOnly("delete");
  }

  writeFile(): Promise<void> {
    return Promise.reject(this.readOnly("write to"));
  }

  writeFileSync(): void {
    throw this.readOnly("write to");
  }

  mkdir(): Promise<void> {
    return Promise.reject(this.readOnly("create a directory in"));
  }

  mkdirSync(): void {
    throw this.readOnly("create a directory in");
  }

  move(): Promise<void> {
    return Promise.reject(this.readOnly("move"));
  }

  moveSync(): void {
    throw this.readOnly("move");
  }

  copy(): Promise<void> {
    return Promise.reject(this.readOnly("copy"));
  }

  copySync(): void {
    throw this.readOnly("copy");
  }

  /**
   * Every mutation is refused rather than ignored. omen must never modify the working
   * tree, and a silently dropped write would surface later as a confusing read.
   */
  private readOnly(action: string): SnapshotFileSystemError {
    return new SnapshotFileSystemError(
      `cannot ${action} a snapshot: it is read-only`,
    );
  }
}

interface Matcher {
  readonly negated: boolean;
  test(path: string): boolean;
}

/**
 * Minimal glob support: `**`, `*`, and `?`, with a leading `!` for negation. That is the
 * subset `tsconfig.json` `include` and `exclude` use.
 */
function toMatcher(pattern: string): Matcher {
  const negated = pattern.startsWith("!");
  const body = toPosixPath(negated ? pattern.slice(1) : pattern);

  let expression = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "*") {
      if (body[index + 1] === "*") {
        if (body[index + 2] === "/") {
          // `**/` matches zero or more directory segments.
          expression += "(?:[^/]*/)*";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else if (char !== undefined) {
      expression += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }

  const regex = new RegExp(`^${expression}$`);
  return { negated, test: (path) => regex.test(path) };
}
