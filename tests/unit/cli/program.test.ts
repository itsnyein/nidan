import { describe, expect, it } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { createProgram } from "../../../src/cli/program.js";

function run(args: string[]): string {
  const program = createProgram().exitOverride();
  let output = "";
  program.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    },
  });

  // Commander throws a CommanderError for --version and --help once exitOverride is set;
  // the output written before the throw is what we assert on.
  try {
    program.parse(args, { from: "user" });
  } catch {
    // Expected: exitOverride turns the process exit into a throw.
  }

  return output;
}

describe("createProgram", () => {
  it("reports the version from package.json", () => {
    expect(run(["--version"])).toBe(`${packageJson.version}\n`);
  });

  it("names the program in its help output", () => {
    expect(run(["--help"])).toContain("omen");
  });
});
