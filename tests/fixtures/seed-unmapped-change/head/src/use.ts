import { DEFAULT_RETRIES, type Options } from "./types.js";

export function withDefaults(options: Partial<Options>): Options {
  return { retries: options.retries ?? DEFAULT_RETRIES };
}
