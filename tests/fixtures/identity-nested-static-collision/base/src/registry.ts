export class Registry {
  static create(): number {
    function f(): number {
      return 1;
    }
    return f();
  }

  create(): number {
    function f(): number {
      return 2;
    }
    return f();
  }
}
