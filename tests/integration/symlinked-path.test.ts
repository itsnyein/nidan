import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo } from "../helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const CLI = resolve("dist/cli.js");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

// dist/cli.js is built once by the globalSetup in vitest.config.ts.

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], {
      cwd,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/**
 * Builds a fixture repository and returns a symlinked path to it.
 *
 * This is the shape that produced two separate bugs: a path reaching the repository
 * through a link resolves to a different string than the one Git reports, so any prefix
 * comparison that skipped canonicalization silently decided the path was elsewhere.
 */
async function linkedRepo(
  name: string,
): Promise<{ real: string; linked: string }> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);

  const linkRoot = await mkdtemp(join(tmpdir(), "nidan-link-"));
  cleanups.push(() => rm(linkRoot, { recursive: true, force: true }));
  const linked = join(linkRoot, "repo-link");
  await symlink(repo.path, linked, "junction");

  return { real: repo.path, linked };
}

describe("analysis through a symlinked path", () => {
  it(
    "runs from a symlinked repository directory",
    async () => {
      const { linked } = await linkedRepo("config-tsconfig");

      const result = await runCli(["base", "head", "--format", "json"], linked);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { status: "ok", analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "accepts a symlinked path given to --directory from elsewhere",
    async () => {
      const { linked } = await linkedRepo("config-tsconfig");

      const result = await runCli(
        ["base", "head", "-C", linked, "--format", "json"],
        resolve("."),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { status: "ok" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "resolves a relative --config against a symlinked --directory",
    async () => {
      // The exact T1.4 repro. Note the `-C`: running *from* a symlinked directory proves
      // nothing, because Node resolves the path before nidan ever sees it. The link has to
      // arrive as an argument. Git then reports the repository root resolved, so a config
      // resolved against the unresolved link looks like it sits outside the repository
      // and the run exits 2.
      const { linked } = await linkedRepo("config-tsconfig");

      const result = await runCli(
        [
          "base",
          "head",
          "-C",
          linked,
          "--config",
          "tsconfig.json",
          "--format",
          "json",
        ],
        resolve("."),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "routes node_modules to disk through the link",
    async () => {
      // The T1.2 bug: realpath on a dependency returned a path outside the root as
      // spelled, so dependency routing denied it and types failed to resolve.
      const { linked } = await linkedRepo("layout-pnpm");

      const result = await runCli(["base", "head", "--format", "json"], linked);

      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        run: { status: string; reasons: Array<{ kind: string }> };
      };
      expect(report.run.reasons.map((reason) => reason.kind)).not.toContain(
        "dependencies-not-installed",
      );
      expect(report.run.status).toBe("ok");
    },
    TIMEOUT_MS,
  );

  it(
    "produces the same report through the link as through the real path",
    async () => {
      const { real, linked } = await linkedRepo("overlay-basic");

      const direct = await runCli(["base", "head", "--format", "json"], real);
      const through = await runCli(
        ["base", "head", "--format", "json"],
        linked,
      );

      // Byte-identical: how the repository was reached must not reach the output.
      expect(through.stdout).toBe(direct.stdout);
    },
    TIMEOUT_MS,
  );
});
