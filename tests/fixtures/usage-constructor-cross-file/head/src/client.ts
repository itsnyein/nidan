export class Client {
  constructor(readonly url: string) {
    if (url === "") throw new Error("url is required");
  }
}
