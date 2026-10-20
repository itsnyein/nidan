import { total } from "./calc.js";

export function neverSeen(values: number[]): number {
  return total(values) + 1;
}
