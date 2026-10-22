import { describe, expect, it } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { GitError } from "../../../src/git/errors.js";
import { ConfigError } from "../../../src/project/config.js";
import {
  EXIT_FAILED,
  EXIT_USAGE,
  exitCodeFor,
} from "../../../src/cli/exit-codes.js";
import { createProgram, type CliInvocation } from "../../../src/cli/program.js";

interface ParseResult {
  readonly output: string;
  readonly invocation?: CliInvocation;
  readonly error?: { code?: string; message: string };
}

/** Parses an argument list without spawning a process or exiting. */
function parse(args: string[]): ParseResult {
  let invocation: CliInvocation | undefined;
  let output = "";

  const program = createProgram((parsed) => {
    invocation = parsed;
  }).exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    },
  });

  try {
    program.parse(["node", "nidan", ...args]);
  } catch (error) {
    const typed = error as { code?: string; message: string };
    return { output, ...(invocation && { invocation }), error: typed };
  }
  return { output, ...(invocation && { invocation }) };
}

describe("argument surface", () => {
  it("reports the package version", () => {
    expect(parse(["--version"]).output).toBe(`${packageJson.version}\n`);
  });

  it("documents every flag and the exit codes in help", () => {
    // Commander wraps descriptions, so compare against whitespace-collapsed text rather
    // than asserting on an accidental line break.
    const output = parse(["--help"]).output.replace(/\s+/g, " ");

    for (const fragment of [
      "<base>",
      "<head>",
      "-C, --directory",
      "--config",
      "--format",
      "resolved against --directory",
      "found upward from it",
      "Exit codes:",
      "never depends on how many usages",
    ]) {
      expect(output).toContain(fragment);
    }
  });

  it("takes base and head as positional arguments", () => {
    const { invocation } = parse(["main", "feature"]);

    expect(invocation?.base).toBe("main");
    expect(invocation?.head).toBe("feature");
  });

  it("defaults the format to text and the directory to unset", () => {
    const { invocation } = parse(["main", "feature"]);

    expect(invocation?.options.format).toBe("text");
    expect(invocation?.options.directory).toBeUndefined();
    expect(invocation?.options.config).toBeUndefined();
  });

  it.each([
    [
      "long",
      [
        "--directory",
        "/repo",
        "--config",
        "/repo/tsconfig.json",
        "--format",
        "json",
      ],
    ],
    [
      "the -C alias",
      ["-C", "/repo", "--config", "/repo/tsconfig.json", "--format", "json"],
    ],
  ])("accepts %s option spellings", (_label, flags) => {
    const { invocation } = parse(["main", "feature", ...flags]);

    expect(invocation?.options.directory).toBe("/repo");
    expect(invocation?.options.config).toBe("/repo/tsconfig.json");
    expect(invocation?.options.format).toBe("json");
  });

  it("has no short alias for --format", () => {
    // Withheld deliberately: a short flag is cheap to add later and breaking to remove.
    expect(parse(["main", "feature", "-f", "json"]).error?.code).toBe(
      "commander.unknownOption",
    );
    expect(parse(["--help"]).output).not.toContain("-f, --format");
  });

  it("rejects an unknown format rather than guessing", () => {
    const { error, invocation } = parse([
      "main",
      "feature",
      "--format",
      "yaml",
    ]);

    expect(error?.message).toMatch(/expected one of text, json/);
    expect(invocation).toBeUndefined();
  });

  it("requires both refs", () => {
    expect(parse(["main"]).error?.code).toBe("commander.missingArgument");
    expect(parse([]).error?.code).toBe("commander.missingArgument");
  });

  it("rejects an unknown flag", () => {
    expect(parse(["main", "feature", "--nope"]).error?.code).toBe(
      "commander.unknownOption",
    );
  });
});

describe("exit code mapping", () => {
  it.each([
    ["invalid-ref", EXIT_USAGE],
    ["unknown-ref", EXIT_USAGE],
    ["not-a-repository", EXIT_USAGE],
    ["missing-object", EXIT_FAILED],
    ["command-failed", EXIT_FAILED],
  ] as const)("maps a %s git error to exit %i", (kind, expected) => {
    expect(exitCodeFor(new GitError(kind, "boom"))).toBe(expected);
  });

  it("separates a bad config path from a broken config", () => {
    // The first is the user's input to fix; the second is repository content, so the run
    // failed rather than being misused.
    expect(exitCodeFor(new ConfigError("invalid-config-path", "boom"))).toBe(
      EXIT_USAGE,
    );
    expect(exitCodeFor(new ConfigError("unreadable-config", "boom"))).toBe(
      EXIT_FAILED,
    );
  });

  it("treats an unrecognized failure as a failed run, not a usage error", () => {
    // Exit 2 tells the user to fix their command. An unexpected error is not their fault,
    // and saying so would send them looking in the wrong place.
    expect(exitCodeFor(new Error("unexpected"))).toBe(EXIT_FAILED);
    expect(exitCodeFor("not even an error")).toBe(EXIT_FAILED);
  });
});
