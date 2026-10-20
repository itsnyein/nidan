import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Builds dist/cli.js once in the main process. A per-file build races: Vitest runs
    // test files in parallel workers, and two tsup processes writing the same output
    // leave one file's test executing a half-written binary.
    globalSetup: ["tests/helpers/build-cli.ts"],
  },
});
