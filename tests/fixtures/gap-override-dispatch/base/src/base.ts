export class Reporter {
  render(value: string): string {
    return value;
  }
}

export class LoudReporter extends Reporter {
  render(value: string): string {
    return value.toUpperCase();
  }
}
