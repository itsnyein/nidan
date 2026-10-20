import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Git output can exceed the default 1 MB buffer on a large tree listing. The limit stays
 * finite so a pathological repository fails loudly instead of exhausting memory.
 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs Git with an argument array. There is no shell, so no argument can be interpreted
 * as a command, a redirect, or a glob.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    throw new GitError(
      "command-failed",
      `git ${args.join(" ")} failed in ${cwd}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * A ref that begins with `-` would be read by Git as an option rather than a revision.
 * Callers also pass refs into argument positions guarded by `--end-of-options`, so this
 * is the second of two defences, not the only one.
 */
export function assertUsableRef(ref: string): void {
  if (ref === "") {
    throw new GitError("invalid-ref", "ref is empty");
  }
  if (ref.startsWith("-")) {
    throw new GitError(
      "invalid-ref",
      `ref "${ref}" starts with "-", which Git reads as an option`,
    );
  }
  if (ref.includes("\0") || ref.includes("\n")) {
    throw new GitError(
      "invalid-ref",
      `ref "${ref}" contains a control character`,
    );
  }
}
