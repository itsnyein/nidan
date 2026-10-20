/** Adds the values, returning zero for an empty list. */
export function total(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
