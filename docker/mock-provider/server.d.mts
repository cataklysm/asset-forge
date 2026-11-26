export type MockFailure = number | 'invalid' | 'hang';

export interface MockProvider {
  url: string;
  close(): Promise<void>;
  requests: {
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }[];
}

export function startMockProvider(options?: {
  port?: number;
  host?: string;
  delayMs?: number;
  failures?: MockFailure[];
  /** When non-empty, every request needs `Authorization: Bearer <apiKey>`, otherwise it gets 401. */
  apiKey?: string;
  /** Receives one line per answered request: method, path and status, never a header. */
  log?: (line: string) => void;
}): Promise<MockProvider>;

export const MOCK_MODEL = 'mock-vision';
export const MOCK_TEXT_MODEL = 'mock-text';
export const MOCK_LEGACY_MODEL = 'mock-legacy';
