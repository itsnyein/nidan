export function parse(value: string): string;
export function parse(value: number): string;
export function parse(value: boolean): string;
export function parse(value: string | number | boolean): string {
  return String(value);
}
