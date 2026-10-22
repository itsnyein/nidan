import { Client } from "./client.js";

export class RetryingClient extends Client {
  constructor(url: string) {
    super(url);
  }
}
