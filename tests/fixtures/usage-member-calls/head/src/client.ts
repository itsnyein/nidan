export class Client {
  send(body: string): string {
    return body.trim();
  }

  static describe(): string {
    return "client instance";
  }
}
