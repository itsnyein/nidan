// @ts-expect-error the package is deliberately absent, which is what this case proves
import { helper } from "missing-package";
import { greet } from "./greet.js";

export function report(): string {
  return greet() + String(helper);
}
