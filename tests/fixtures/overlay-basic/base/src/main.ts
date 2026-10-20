import { formatRow } from "./format.js";

export function render(rows: string[]): string[] {
  return rows.map((row) => formatRow(row));
}
