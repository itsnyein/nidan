import { GitError } from "../git/errors.js";
import { ConfigError } from "../project/config.js";

/**
 * Exit codes are public contract and never depend on results.
 *
 * `0` covers both `ok` and `degraded`, so a CI pipeline cannot read "zero usages" as
 * "safe". The split between `1` and `2` is the difference between "the analysis could
 * not complete" and "fix your input".
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Git error kinds that mean the user supplied something wrong. */
const USER_INPUT_KINDS = new Set([
  "invalid-ref",
  "unknown-ref",
  "not-a-repository",
]);

export function exitCodeFor(error: unknown): number {
  if (error instanceof GitError) {
    return USER_INPUT_KINDS.has(error.kind) ? EXIT_USAGE : EXIT_FAILED;
  }
  if (error instanceof ConfigError) {
    // A config path the user named wrongly is their input; a config that cannot be
    // parsed is repository content and means the run failed.
    return error.kind === "invalid-config-path" ? EXIT_USAGE : EXIT_FAILED;
  }
  return EXIT_FAILED;
}

export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
