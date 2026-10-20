/**
 * Why a Git operation failed, in terms the caller can act on. The CLI maps these to exit
 * codes: an input problem is the user's, anything else is a failed run.
 */
export type GitErrorKind =
  /** The path is not inside a Git repository. */
  | "not-a-repository"
  /** The ref is malformed, or rejected before Git saw it. */
  | "invalid-ref"
  /** The ref is well-formed but does not resolve here, as in a shallow clone. */
  | "unknown-ref"
  /** An object was requested that this repository does not have. */
  | "missing-object"
  /** Git ran and failed for some other reason. */
  | "command-failed";

export class GitError extends Error {
  override readonly name = "GitError";

  constructor(
    readonly kind: GitErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
