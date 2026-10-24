import type { Store } from "./store.js";
import { FileStore } from "./store.js";

export function persist(store: Store): string {
  return store.save("x");
}

export function persistConcrete(): string {
  return new FileStore().save("y");
}
