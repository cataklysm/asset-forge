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
}): Promise<MockProvider>;

export const MOCK_MODEL = 'mock-vision';
