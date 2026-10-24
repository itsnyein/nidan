import { configDefaults, defineConfig } from "vitest/config";

/**
 * The randomized suite builds 40 Git repositories inside a single test, which takes
 * minutes rather than seconds. It runs as its own CI job with its own time budget, so the
 * main run excludes it — a test that long inside the main run makes the per-test duration
 * threshold unusable as a detector, because the one legitimate outlier hides every other
 * breach behind it.
 *
 * Set by the workflow rather than by a package script: a script would need shell quoting
 * that differs between the POSIX and Windows runners, and the exclusion has to be the
 * same on both.
 */
const EXCLUDE_RANDOMIZED = process.env["NIDAN_EXCLUDE_RANDOMIZED"] === "1";

/**
 * Matched by name, not listed file by file, so the exclusion here and the dedicated
 * job's `vitest run randomized` filter select the same set. Two hand-maintained lists
 * would drift, and the drift would be silent in the direction that matters: a randomized
 * file excluded from the main run and never added to the randomized job runs nowhere.
 */
const RANDOMIZED_GLOB = "tests/**/*-randomized.test.ts";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      ...(EXCLUDE_RANDOMIZED ? [RANDOMIZED_GLOB] : []),
    ],
    // Builds dist/cli.js once in the main process. A per-file build races: Vitest runs
    // test files in parallel workers, and two tsup processes writing the same output
    // leave one file's test executing a half-written binary.
    globalSetup: ["tests/helpers/build-cli.ts"],
    /**
     * Measured, not guessed. Each test file builds real Git repositories and loads two
     * fully type-checked programs, so the suite is bounded by memory rather than by CPU:
     * on the 8-core, 8 GB development machine the default of 7 forks drove three separate
     * runs into the OOM killer, each presenting as a defect until it was re-run.
     *
     * Full-suite wall time was 356 s at 7 forks, **337 s at 4**, and 354 s at 3 — so four
     * is not a trade of speed for stability; it was the fastest of the three. Fewer
     * concurrent programs is the mechanism; the wall-time measurement is why it costs
     * nothing to take.
     */
    maxWorkers: 4,
    // Annotates a failing test with CPU against wall time. See the file for why that
    // number is the one that separates a starved run from a defect.
    setupFiles: ["tests/helpers/contention.ts"],
    // `default` is kept: this one adds a diagnosis, it does not replace the report.
    reporters: ["default", "./tests/helpers/contention-reporter.ts"],
  },
});
