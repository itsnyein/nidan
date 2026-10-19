import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

export function createProgram(): Command {
  return new Command()
    .name("omen")
    .description(packageJson.description)
    .version(packageJson.version);
}
