import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { findRepositoryRoot } from "../git/refs.js";
import { toPosixPath } from "./paths.js";

/**
 * The one place paths are canonicalized.
 *
 * Every path nidan compares is first resolved through `realpath`. This matters because
 * Git reports the repository root with symlinks already resolved — `/var` is a link to
 * `/private/var` on macOS, and every temporary directory lives under it. A path that
 * skips this step compares unequal to one that did not, and the failure is silent: a
 * prefix check simply decides the path is somewhere else.
 *
 * That bug has already been found twice from this single cause — dependency routing
 * denying `node_modules` under a symlinked repository, and a relative `--config`
 * appearing to sit outside the repository. Centralizing it removes the class rather than
 * the instances.
 */
export interface ProjectLocation {
  /** Canonical absolute POSIX path of the repository root. */
  readonly repoRoot: string;
  /** Canonical absolute POSIX path of the directory nidan was pointed at. */
  readonly projectDirectory: string;
  /** Canonical absolute POSIX path of an explicit config, when one was given. */
  readonly configPath?: string;
}

export interface LocateOptions {
  /** Project directory as the user spelled it, resolved against `cwd`. */
  readonly directory?: string;
  /** Explicit config as the user spelled it, resolved against the project directory. */
  readonly config?: string;
  /** The directory the command was invoked from. */
  readonly cwd: string;
}

/**
 * Resolves the project directory, the repository root, and any explicit config into one
 * canonical set. Callers take paths from here rather than deriving their own.
 */
export async function locateProject(
  options: LocateOptions,
): Promise<ProjectLocation> {
  const projectDirectory = canonicalize(
    resolve(options.cwd, options.directory ?? "."),
  );
  const repoRoot = canonicalize(await findRepositoryRoot(projectDirectory));

  if (options.config === undefined) {
    return { repoRoot, projectDirectory };
  }

  // A relative config resolves against the project directory, giving git's "as if started
  // there" semantics: moving the invocation without moving the paths cannot change which
  // files are read.
  const configPath = canonicalize(
    isAbsolute(options.config)
      ? options.config
      : resolve(projectDirectory, options.config),
  );

  return { repoRoot, projectDirectory, configPath };
}

/**
 * Resolves symlinks and normalizes separators. A path that does not exist is returned
 * normalized but unresolved, so the caller can produce a better error than this can.
 */
export function canonicalize(path: string): string {
  try {
    return toPosixPath(realpathSync.native(path));
  } catch {
    return toPosixPath(path);
  }
}
