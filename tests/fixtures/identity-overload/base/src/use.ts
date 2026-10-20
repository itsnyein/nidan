import { parse } from "./parse.js";

export function render(value: string): string {
  return parse(value);
}
