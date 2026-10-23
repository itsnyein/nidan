import { Client } from "./client.js";

export function report(client: Client): string {
  const direct = client.send("ping");
  const indexed = client["send"]("pong");
  const described = Client.describe();
  return direct + indexed + described;
}
