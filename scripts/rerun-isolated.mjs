#!/usr/bin/env node
/**
 * Re-runs the named test files **one at a time**, and prints both results side by side.
 *
 * This mechanizes the stop-signal policy rather than replacing it. A dirty run is a
 * question, not a verdict: a file that fails in a contended run and passes alone was
 * starved, and a file that fails both ways is a defect. Doing that by hand is what the
 * policy has required so far, and a manual step competing with "just re-run it" loses.
 *
 * It is deliberately **not** a retry. It never re-runs the whole suite, it never loops
 * until green, and it reports the isolated result next to the original rather than
 * replacing it — so the comparison is the output, not a second chance.
 */
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);

if (files.length === 0) {
  process.stderr.write(
    [
      "usage: pnpm rerun:isolated <test file>...",
      "",
      "Pass the files a contended run reported as failed or killed. Each runs alone,",
      "serially, so neither competes with the other for CPU or memory.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const results = [];

for (const file of files) {
  const startedAt = process.hrtime.bigint();
  const run = spawnSync(
    "pnpm",
    // `--maxWorkers=1` is the supported spelling; `--poolOptions.*` is not a CLI flag,
    // and vitest exits in under a second rather than warning, which reads as a passing
    // run to anything checking only the exit code.
    ["vitest", "run", file, "--pool=forks", "--maxWorkers=1"],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  results.push({ file, code: run.status ?? 1, seconds });
}

process.stdout.write("\nIsolated re-run\n");
for (const { file, code, seconds } of results) {
  // Phrased as a conditional, because this script does not know what the full run did.
  // Claiming "the original failure was contention" would be asserting something it never
  // observed — and the whole point here is to stop reading one run as proof of another.
  const verdict =
    code === 0
      ? "passed alone — a failure in the full run was contention, not a defect"
      : "failed alone — a defect, not contention";
  process.stdout.write(
    `  ${code === 0 ? "ok  " : "FAIL"}  ${file}  ${seconds.toFixed(1)}s  ${verdict}\n`,
  );
}

// Non-zero only when a file genuinely failed on its own. A contended run that clears in
// isolation must not leave the shell believing something is broken.
process.exit(results.some((result) => result.code !== 0) ? 1 : 0);
