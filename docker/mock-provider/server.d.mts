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
  /** One entry per multipart request to `/api/v1/image/edit` or `/api/v1/image/upscale`, recorded before the key check. */
  imageRequests: {
    path: string;
    authorization: string | null;
    fields: Record<string, string>;
    fileBytes: number;
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

export const MOCK_EDIT_MODEL = 'mock-edit';
export const MOCK_EDIT_BASIC_MODEL = 'mock-edit-basic';
export const MOCK_PROMPT_NO_BALANCE = 'mock:402';
export const MOCK_PROMPT_VIOLATION = 'mock:422';
export const MOCK_PROMPT_BUSY = 'mock:429';
export const MOCK_PROMPT_FAIL = 'mock:500';
export const MOCK_PROMPT_SLOW = 'mock:slow';
export const MOCK_PROMPT_VIOLATION_OK = 'mock:violation-200';
