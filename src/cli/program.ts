import { Command, InvalidArgumentError } from "commander";

import packageJson from "../../package.json" with { type: "json" };
import type { OutputFormat } from "../index.js";

export interface CliOptions {
  readonly directory?: string;
  readonly config?: string;
  readonly format: OutputFormat;
}

export interface CliInvocation {
  readonly base: string;
  readonly head: string;
  readonly options: CliOptions;
}

const FORMATS: readonly OutputFormat[] = ["text", "json"];

/**
 * Builds the argument parser.
 *
 * Flag spellings are public contract from the release that ships them; changing one later
 * is a breaking change.
 */
export function createProgram(
  onRun: (invocation: CliInvocation) => void,
): Command {
  return new Command()
    .name("omen")
    .description(packageJson.description)
    .version(packageJson.version)
    .argument("<base>", "ref to compare from")
    .argument("<head>", "ref to compare to")
    .option(
      "-C, --directory <path>",
      "repository to analyze (default: current directory)",
    )
    .option("--config <path>", "explicit tsconfig.json or jsconfig.json")
    .option(
      "-f, --format <format>",
      `output format: ${FORMATS.join(" | ")}`,
      parseFormat,
      "text",
    )
    .addHelpText(
      "after",
      [
        "",
        "Exit codes:",
        "  0  the analysis ran (status ok or degraded)",
        "  1  the analysis failed",
        "  2  usage or input error",
        "",
        "The exit code never depends on how many usages were found.",
      ].join("\n"),
    )
    .action((base: string, head: string, options: CliOptions) => {
      onRun({ base, head, options });
    });
}

function parseFormat(value: string): OutputFormat {
  const match = FORMATS.find((format) => format === value);
  if (match === undefined) {
    throw new InvalidArgumentError(`expected one of ${FORMATS.join(", ")}`);
  }
  return match;
}
