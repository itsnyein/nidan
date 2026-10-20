export function alpha(): number {
  function helper(): number {
    return 1;
  }
  return helper();
}

export function beta(): number {
  function helper(): number {
    return 2;
  }
  return helper();
}
