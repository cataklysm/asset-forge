export type MockFailure = number | 'invalid' | 'hang';

export interface MockProvider {
  url: string;
  close(): Promise<void>;
  /** Answers every waiting `MOCK_PROMPT_SLOW` request now and keeps the server running. */
  releaseSlow(): void;
  /** How many `MOCK_PROMPT_SLOW` requests are waiting for their answer. */
  slowWaiting(): number;
  /**
   * The latest requests, at most `maxRecorded`; the array stays the same while the oldest entries are dropped. A chat
   * image in `body` is kept as `mockImageDigest` of its bytes, not as Base64.
   */
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
  /** Delays every chat answer, a scripted status failure included. */
  delayMs?: number;
  /** Taken one per chat request, before its model or image is checked (desktop tests count on this order). */
  failures?: MockFailure[];
  /** When non-empty, every request needs `Authorization: Bearer <apiKey>`, otherwise it gets 401. */
  apiKey?: string;
  /** Receives one line per answered request: method, path and status, never a header. */
  log?: (line: string) => void;
  /**
   * When true, a `/v1/chat/completions` request carrying `response_format` gets 400, and one without it
   * gets the tag JSON (standing for a caller's retry without `response_format`).
   */
  refuseResponseFormat?: boolean;
  /** How many entries `requests` and `imageRequests` each keep, the oldest dropped first; default `MOCK_MAX_RECORDED`. */
  maxRecorded?: number;
}): Promise<MockProvider>;

/** The default of `maxRecorded`. */
export const MOCK_MAX_RECORDED: number;

/** The words the first six tags come from. */
export const MOCK_VOCABULARY: readonly string[];
/** The views the seventh tag comes from. */
export const MOCK_VIEWS: readonly string[];
/** The styles the eighth tag comes from. */
export const MOCK_STYLES: readonly string[];

/**
 * What `requests` keeps of a chat image (an Ollama `images` entry, the data of an OpenAI image data URL) instead of
 * its Base64.
 *
 * @param bytes the image's bytes
 * @returns `sha256:<hex>`
 */
export function mockImageDigest(bytes: Uint8Array): string;

export const MOCK_MODEL = 'mock-vision';
export const MOCK_TEXT_MODEL = 'mock-text';
export const MOCK_LEGACY_MODEL = 'mock-legacy';

/** OpenAI endpoints: answers with a `<think>` block before the content. */
export const MOCK_THINKING_MODEL = 'mock-thinking';
/** OpenAI endpoints: wraps a JSON answer in a code fence. */
export const MOCK_FENCED_MODEL = 'mock-fenced';
/** OpenAI endpoints: answers `content: null` with `reasoning_content`. */
export const MOCK_REASONING_ONLY_MODEL = 'mock-reasoning-only';
/** OpenAI endpoints: a name with `/` and `:` that behaves like `mock-vision`. */
export const MOCK_SLASH_MODEL = 'Qwen/Mock-VL:7B';

export const MOCK_EDIT_MODEL = 'mock-edit';
export const MOCK_EDIT_BASIC_MODEL = 'mock-edit-basic';
export const MOCK_PROMPT_NO_BALANCE = 'mock:402';
export const MOCK_PROMPT_VIOLATION = 'mock:422';
export const MOCK_PROMPT_BUSY = 'mock:429';
export const MOCK_PROMPT_FAIL = 'mock:500';
export const MOCK_PROMPT_SLOW = 'mock:slow';
export const MOCK_PROMPT_VIOLATION_OK = 'mock:violation-200';
