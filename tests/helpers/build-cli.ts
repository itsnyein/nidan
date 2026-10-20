import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Builds the CLI once, before any test worker starts.
 *
 * This runs as a Vitest `globalSetup` rather than in each integration file's `beforeAll`.
 * Vitest runs test files in parallel workers, so a per-file build means two `tsup`
 * processes writing `dist/cli.js` at the same time — one truncates the binary while the
 * other file's test is executing it, and the test sees empty output. It fails only when
 * the timing lines up, which is the worst kind of failure to leave in place.
 *
 * tsup is invoked through Node rather than through `pnpm build`, because on Windows
 * `pnpm` is a `.cmd` shim that `execFile` cannot resolve without a shell.
 */
export default async function buildCli(): Promise<void> {
  const require = createRequire(`${process.cwd()}/`);
  const tsupBin = require.resolve("tsup/dist/cli-default.js");
  await execFileAsync(process.execPath, [tsupBin], { cwd: process.cwd() });
}
