import { total } from "./calc.js";

export function summary(values: number[]): string {
  return `total: ${String(total(values))}`;
}
