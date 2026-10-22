import { greet } from "./index.js";

export function report() {
  return greet().toUpperCase();
}
