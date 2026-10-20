export class Client {
  constructor(readonly url: string) {
    if (url === "") throw new Error("url is required");
  }
}

export class RetryingClient extends Client {
  constructor(url: string) {
    super(url);
  }
}
