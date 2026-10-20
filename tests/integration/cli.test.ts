import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  // The CLI is tested as the artifact users actually run, not as imported modules: the
  // shebang, the bundle, and the exit code are all part of the contract.
  //
  // tsup is invoked through Node rather than through `pnpm build`: on Windows `pnpm` is a
  // .cmd shim, which `execFile` cannot resolve without a shell, and a shell is exactly
  // what this project avoids spawning.
  const require = createRequire(`${process.cwd()}/`);
  const tsupBin = require.resolve("tsup/dist/cli-default.js");
  await execFileAsync(process.execPath, [tsupBin], { cwd: process.cwd() });
}, TIMEOUT_MS);

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
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

async function fixtureRepo(name: string): Promise<string> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);
  return repo.path;
}

describe("omen end to end", () => {
  it(
    "analyzes a repository and exits 0 with JSON",
    async () => {
      const repo = await fixtureRepo("overlay-basic");

      const result = await runCli(["base", "head", "--format", "json"], repo);

      expect(result.code).toBe(0);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        schemaVersion: expect.any(Number) as number,
        run: { status: "ok", analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "produces byte-identical JSON for the same input",
    async () => {
      const repo = await fixtureRepo("overlay-basic");

      const first = await runCli(["base", "head", "--format", "json"], repo);
      const second = await runCli(["base", "head", "--format", "json"], repo);

      expect(second.stdout).toBe(first.stdout);
      // Determinism is only meaningful if the output is non-trivial.
      expect(first.stdout.length).toBeGreaterThan(100);
    },
    TIMEOUT_MS,
  );

  it(
    "contains no absolute paths or timestamps",
    async () => {
      const repo = await fixtureRepo("overlay-basic");

      const { stdout } = await runCli(
        ["base", "head", "--format", "json"],
        repo,
      );

      expect(stdout).not.toContain(repo);
      expect(stdout).not.toContain("/private/");
      expect(stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    },
    TIMEOUT_MS,
  );

  it(
    "exits 0 and never says 'no impact' when nothing was found",
    async () => {
      const repo = await fixtureRepo("overlay-basic");

      const result = await runCli(["base", "head"], repo);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("No static usages found");
      expect(result.stdout.toLowerCase()).not.toContain("no impact");
      expect(result.stdout).toContain("Not analyzed by design:");
    },
    TIMEOUT_MS,
  );

  it(
    "exits 0 for a degraded run, because the code must not depend on results",
    async () => {
      const repo = await fixtureRepo("config-absent");

      const result = await runCli(["base", "head", "--format", "json"], repo);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { status: "degraded" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reports the merge base it compared",
    async () => {
      const repo = await fixtureRepo("overlay-basic");

      const { stdout } = await runCli(
        ["base", "head", "--format", "json"],
        repo,
      );
      const report = JSON.parse(stdout) as {
        run: {
          refs: { baseSha: string; mergeBaseSha: string; headSha: string };
        };
      };

      // Linear history, so the merge base is the base commit itself.
      expect(report.run.refs.mergeBaseSha).toBe(report.run.refs.baseSha);
      expect(report.run.refs.headSha).not.toBe(report.run.refs.baseSha);
    },
    TIMEOUT_MS,
  );

  it.each([
    ["an unknown ref", ["base", "no-such-ref"]],
    ["an option-like ref", ["base", "--upload-pack=touch /tmp/pwned"]],
    ["a missing argument", ["base"]],
    ["an unknown flag", ["base", "head", "--nope"]],
    ["an unknown format", ["base", "head", "--format", "yaml"]],
  ])(
    "exits 2 for %s",
    async (_label, args) => {
      const repo = await fixtureRepo("overlay-basic");

      const result = await runCli(args, repo);

      expect(result.code).toBe(2);
    },
    TIMEOUT_MS,
  );

  it(
    "finds the repository root from a subdirectory",
    async () => {
      const repo = await fixtureRepo("config-tsconfig");

      // No --directory: the project directory defaults to the invocation cwd, and the
      // repository root is discovered upward from there.
      const result = await runCli(
        ["base", "head", "--format", "json"],
        join(repo, "src"),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { status: "ok", analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "resolves --directory against the invocation cwd",
    async () => {
      const repo = await fixtureRepo("config-tsconfig");

      const result = await runCli(
        ["base", "head", "-C", "..", "--format", "json"],
        join(repo, "src"),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { status: "ok", analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "resolves a relative --config against --directory, not the cwd",
    async () => {
      const repo = await fixtureRepo("config-tsconfig");

      // Run from src/ but point --directory at the repository root. `tsconfig.json` is
      // relative to that root, not to src/, so it only resolves under the documented
      // semantics. Resolving against the cwd would look for src/tsconfig.json and fail.
      const result = await runCli(
        [
          "base",
          "head",
          "-C",
          repo,
          "--config",
          "tsconfig.json",
          "--format",
          "json",
        ],
        join(repo, "src"),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run: { analysisMode: "tsconfig" },
      });
    },
    TIMEOUT_MS,
  );

  it(
    "exits 2 when a relative --config does not resolve",
    async () => {
      const repo = await fixtureRepo("config-tsconfig");

      const result = await runCli(
        ["base", "head", "--config", "no-such-tsconfig.json"],
        repo,
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("omen:");
    },
    TIMEOUT_MS,
  );

  it(
    "exits 2 outside a repository",
    async () => {
      const result = await runCli(["base", "head"], resolve("/"));

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("omen:");
    },
    TIMEOUT_MS,
  );

  it(
    "prints help and the version without a repository",
    async () => {
      const help = await runCli(["--help"], resolve("/"));
      const version = await runCli(["--version"], resolve("/"));

      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Exit codes:");
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
    TIMEOUT_MS,
  );
});
