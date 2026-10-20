export class Client {
  constructor(readonly url: string) {}
}

export class RetryingClient extends Client {
  constructor(url: string) {
    super(url);
  }
}
