import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Git output can exceed the default 1 MB buffer on a large tree listing. The limit stays
 * finite so a pathological repository fails loudly instead of exhausting memory.
 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Options applied to every Git invocation, before the subcommand.
 *
 * `--literal-pathspecs` is the important one. Passing a filename after `--` stops option
 * parsing but does **not** stop pathspec pattern matching: a file literally named
 * `foo[1].ts` is otherwise a character-class pattern that also matches `foo1.ts`, so one
 * file's output silently arrives under another file's name.
 *
 * `--no-optional-locks` keeps a read-only query from writing to the user's repository.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  "--literal-pathspecs",
  "--no-optional-locks",
  // Paths come back raw rather than C-quoted, so a non-ASCII filename needs no unquoting.
  "-c",
  "core.quotePath=false",
];

/**
 * Builds the environment for a Git child process.
 *
 * Every inherited `GIT_*` variable is dropped. Some redirect the repository outright
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`); others change what a diff reports or
 * run a program to produce it (`GIT_EXTERNAL_DIFF`, `GIT_DIFF_OPTS`). omen must analyze
 * the repository it was pointed at, identically on every machine, and must never execute
 * a program the environment chose — so the whole namespace goes rather than a denylist
 * that a future Git release can outgrow.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

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
    const { stdout, stderr } = await execFileAsync(
      "git",
      [...GIT_GLOBAL_ARGS, ...args],
      {
        cwd,
        env: gitEnvironment(),
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
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
