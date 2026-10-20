export interface Options {
  readonly retries: number;
  readonly timeoutMs?: number;
}

export const DEFAULT_RETRIES = 3;
