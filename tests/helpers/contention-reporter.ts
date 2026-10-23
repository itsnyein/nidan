import { freemem, loadavg, totalmem } from "node:os";

/**
 * Diagnoses failures the per-test hook structurally cannot see.
 *
 * When the OS kills a worker, the process is gone: no `afterEach` runs, no timing is
 * recorded, and Vitest reports the file's tests as never having completed. That shape
 * reached this repository three times in one day and read as a regression each time —
 * once on a documentation-only change, which can affect no test at all.
 *
 * So the classification has to happen at the **run** level too. This prints what the
 * machine looked like when the run ended and names the files whose workers died, which is
 * the evidence a reader needs to tell "the code is wrong" from "the machine was busy".
 */
export default class ContentionReporter {
  onTestRunEnd(_modules: unknown, unhandledErrors: readonly unknown[]): void {
    const errors = unhandledErrors.length;
    if (errors === 0) return;

    const killed = unhandledErrors.map(messageOf).filter((message) => {
      // `SIGKILL` is the OOM killer; a worker that "exited unexpectedly" without a signal
      // is a crash worth reading differently, so both are counted but only one is named.
      return message.includes("SIGKILL");
    });

    const load = loadavg()
      .map((average) => average.toFixed(1))
      .join(" / ");
    const freeMb = Math.round(freemem() / 1024 / 1024);
    const totalMb = Math.round(totalmem() / 1024 / 1024);

    const lines = [
      "",
      "[contention] the run ended with unhandled worker errors.",
      `  unhandled errors: ${String(errors)} (${String(killed.length)} with SIGKILL)`,
      `  loadavg at exit:  ${load}`,
      `  memory at exit:   ${String(freeMb)} MB free of ${String(totalMb)} MB`,
    ];

    if (killed.length > 0) {
      lines.push(
        "  A SIGKILLed worker was killed by the OS, not by a failing assertion.",
        "  Files affected:",
        ...filesOf(killed).map((file) => `    ${file}`),
        "  Re-run those files alone before treating this as a defect:",
        "    pnpm rerun:isolated <file>...",
      );
    }

    lines.push("");
    process.stderr.write(lines.join("\n"));
  }
}

/** The message of an unknown thrown value, without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.cause instanceof Error ? error.cause.message : ""}`;
  }
  return String(error);
}

/** The test files named in worker-death messages, de-duplicated and ordered. */
function filesOf(messages: readonly string[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(/(\S+\.test\.ts)/gu)) {
      const file = match[1];
      if (file !== undefined) found.add(file);
    }
  }
  return [...found].sort();
}
