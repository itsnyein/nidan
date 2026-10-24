import { Reporter } from "./base.js";

export function show(reporter: Reporter): string {
  return reporter.render("x");
}
