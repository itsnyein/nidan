import { Client } from "./client.js";

type Ctor = new (url: string) => Client;

export function withRetry(base: Ctor): Ctor {
  void base;
  return base;
}
