import { Client } from "./client.js";

export function typed(client: Client): string {
  return client.send("a");
}

export function untyped(client: any): string {
  return client.send("b");
}
