export class Outer {
  run(values: number[]): number {
    function inner(value: number): number {
      return value + 2;
    }
    return values.map(inner).length;
  }
}

export function outer(values: number[]): number {
  function middle(value: number): number {
    function inner(nested: number): number {
      return nested + 2;
    }
    return inner(value);
  }
  return values.map(middle).length;
}
