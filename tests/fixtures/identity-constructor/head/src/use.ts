import { Client } from "./client.js";

export function makeClient(): Client {
  return new Client("https://example.invalid");
}
