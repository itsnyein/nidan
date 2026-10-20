import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

import { GitError } from "./errors.js";

const LINE_FEED = 0x0a;

interface PendingRead {
  readonly oid: string;
  readonly resolve: (contents: Buffer) => void;
  readonly reject: (error: Error) => void;
}

export interface BlobReader {
  /** Contents of a blob, exactly as Git stored them. No decoding, no normalization. */
  read(oid: string): Promise<Buffer>;
  /** Ends the Git process. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Opens a long-lived `git cat-file --batch` process.
 *
 * A snapshot read touches every source file in the repository, and one process per file
 * would dominate the run. The batch protocol answers an unbounded number of requests over
 * a single pipe, which is why the specification names it.
 *
 * Requests are answered strictly in order, so concurrent reads are safe: the queue below
 * pairs each response with the request that asked for it.
 */
export function openBlobReader(repoRoot: string): BlobReader {
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Typed non-null by the `stdio: ["pipe", "pipe", "pipe"]` overload above.
  const { stdin, stdout } = child;

  const pending: PendingRead[] = [];
  let buffered = Buffer.alloc(0);
  /** Set once a header is parsed and we are waiting for that many bytes of content. */
  let awaitingContent: { request: PendingRead; size: number } | null = null;
  let failure: Error | null = null;

  const failAll = (error: Error): void => {
    failure ??= error;
    if (awaitingContent !== null) {
      awaitingContent.request.reject(error);
      awaitingContent = null;
    }
    while (pending.length > 0) {
      pending.shift()?.reject(error);
    }
  };

  const consume = (): void => {
    for (;;) {
      if (awaitingContent === null) {
        const newline = buffered.indexOf(LINE_FEED);
        if (newline === -1) return;

        const header = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);

        const request = pending.shift();
        if (request === undefined) {
          failAll(
            new GitError(
              "command-failed",
              `unexpected cat-file response: ${header}`,
            ),
          );
          return;
        }

        // "<oid> <type> <size>" on success, "<oid> missing" when the object is absent.
        const fields = header.split(" ");
        const size = fields.length === 3 ? Number(fields[2]) : Number.NaN;
        if (!Number.isInteger(size) || size < 0) {
          request.reject(
            new GitError(
              "missing-object",
              `object ${request.oid} is not in this repository`,
            ),
          );
          continue;
        }
        awaitingContent = { request, size };
      }

      // Git writes a trailing newline after the content that is not part of the object.
      if (buffered.length < awaitingContent.size + 1) return;
      const contents = Buffer.from(buffered.subarray(0, awaitingContent.size));
      buffered = buffered.subarray(awaitingContent.size + 1);
      awaitingContent.request.resolve(contents);
      awaitingContent = null;
    }
  };

  stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    consume();
  });

  child.on("error", (error) => {
    failAll(
      new GitError(
        "command-failed",
        "git cat-file --batch could not be started",
        { cause: error },
      ),
    );
  });

  child.on("close", (code) => {
    if (pending.length > 0 || awaitingContent !== null) {
      failAll(
        new GitError(
          "command-failed",
          `git cat-file --batch exited early with code ${String(code)}`,
        ),
      );
    }
  });

  let closed: Promise<void> | null = null;

  return {
    async read(oid: string): Promise<Buffer> {
      if (failure !== null) throw failure;
      if (closed !== null) {
        throw new GitError("command-failed", "blob reader is closed");
      }
      return new Promise<Buffer>((resolve, reject) => {
        pending.push({ oid, resolve, reject });
        stdin.write(`${oid}\n`, (error) => {
          if (error)
            failAll(
              new GitError("command-failed", `could not request ${oid}`, {
                cause: error,
              }),
            );
        });
      });
    },

    close(): Promise<void> {
      closed ??= new Promise<void>((resolve) => {
        child.once("close", () => {
          resolve();
        });
        stdin.end();
      });
      return closed;
    },
  };
}
