export class Registry {
  static create(): number {
    function f(): number {
      return 10;
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
