import { Client } from "./client.js";
import { withRetry } from "./mix.js";
import { label } from "./tag.js";

export class RetryingClient extends withRetry(Client) {}

export const title = label`hello`;
