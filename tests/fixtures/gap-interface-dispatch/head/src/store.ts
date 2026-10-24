export interface Store {
  save(value: string): string;
}

export class FileStore implements Store {
  save(value: string): string {
    return value.toUpperCase();
  }
}

export class MemoryStore implements Store {
  save(value: string): string {
    return value.trim();
  }
}
