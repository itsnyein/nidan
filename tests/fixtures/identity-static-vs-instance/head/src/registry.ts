export class Registry {
  static create(): Registry {
    return new Registry();
  }

  create(): string {
    return "instance method changed";
  }
}
