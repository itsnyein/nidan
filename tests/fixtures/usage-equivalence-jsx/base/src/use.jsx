import { greet } from "./greet.js";

export function report() {
  return greet().toUpperCase();
}
