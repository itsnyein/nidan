import { analyze } from "../index.js";
import { renderJson } from "../report/json.js";
import { renderText } from "../report/text.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
  messageFor,
} from "./exit-codes.js";
import { createProgram, type CliInvocation } from "./program.js";

async function main(argv: readonly string[]): Promise<number> {
  let invocation: CliInvocation | undefined;
  const program = createProgram((parsed) => {
    invocation = parsed;
  }).exitOverride();

  try {
    program.parse([...argv]);
  } catch (error) {
    // Commander throws for --help and --version too, having already written their output.
    const code = (error as { code?: string }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return EXIT_OK;
    }
    process.stderr.write(`${messageFor(error)}\n`);
    return EXIT_USAGE;
  }

  if (invocation === undefined) return EXIT_OK;

  try {
    const report = await analyze({
      base: invocation.base,
      head: invocation.head,
      ...(invocation.options.directory === undefined
        ? {}
        : { directory: invocation.options.directory }),
      ...(invocation.options.config === undefined
        ? {}
        : { config: invocation.options.config }),
    });

    process.stdout.write(
      invocation.options.format === "json"
        ? renderJson(report)
        : renderText(report),
    );

    // Deliberately not a function of the results: `ok` and `degraded` both exit 0, so a
    // pipeline cannot read "zero usages" as "safe".
    return report.run.status === "failed" ? EXIT_FAILED : EXIT_OK;
  } catch (error) {
    process.stderr.write(`omen: ${messageFor(error)}\n`);
    return exitCodeFor(error);
  }
}

process.exitCode = await main(process.argv);
