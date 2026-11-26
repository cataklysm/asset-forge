import { ModelNameSchema, type JobErrorCode } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';

export const OLLAMA_PROVIDER = 'ollama';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Upper bound for a provider answer; a tag list is a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** `listModels` asks `/api/show` for at most this many models, this many at a time, each within its own limit. */
const MAX_LISTED_MODELS = 100;
const SHOW_CONCURRENCY = 4;
const SHOW_TIMEOUT_MS = 10_000;

class ResponseTooLarge extends Error {}

/** Releases a body that will not be read. Failures are irrelevant: the answer is already decided. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignored
  }
}

/** Reads the body as UTF-8 and stops (cancelling the stream) once it exceeds `MAX_RESPONSE_BYTES`. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignored
      }
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface OllamaVisionOptions {
  baseUrl: string;
  /** The API key in force at call time; null for none. */
  apiKey?: () => string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
}

interface Request {
  path: '/api/chat' | '/api/tags' | '/api/show';
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * A `VisionProvider` over Ollama's `POST /api/chat`, `GET /api/tags` and `POST /api/show`.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 */
export function createOllamaVision(options: OllamaVisionOptions): VisionProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  /**
   * One request: bearer key, timeout, no redirects, capped answer, the error mapping of every call.
   * Resolves with the parsed JSON body, which `interpret` turns into the result; an `invalid_response`
   * thrown by `interpret` is mapped like every other failure. Each failed request is reported once.
   */
  async function request<T>(r: Request, interpret: (body: unknown) => T): Promise<T> {
    r.signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), r.timeoutMs);
    const combined = AbortSignal.any([r.signal, timeout.signal]);
    let status: number | null = null;

    // Every failure is mapped after the caller abort and the timeout have been ruled out.
    const fail = (code: JobErrorCode, cause: unknown): never => {
      if (r.signal.aborted) throw r.signal.reason;
      if (timeout.signal.aborted) throw new JobError('provider_timeout', { cause });
      throw new JobError(code, { cause });
    };

    try {
      const headers: Record<string, string> = {};
      if (r.body !== undefined) headers['content-type'] = 'application/json';
      // Read per request: a key changed or removed in the settings applies to the next call.
      const key = options.apiKey?.() ?? null;
      if (key) headers.authorization = `Bearer ${key}`;

      let response: Response;
      try {
        response = await fetchImpl(`${base}${r.path}`, {
          method: r.body === undefined ? 'GET' : 'POST',
          headers,
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
          signal: combined,
          redirect: 'manual',
        });
      } catch (error) {
        return fail('provider_unreachable', error);
      }
      status = response.status;

      // A redirect is never followed: the configured base URL is the only address the adapter talks to.
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await discard(response);
        return fail('provider_rejected', response.status);
      }

      if (!response.ok) {
        // The body of a failed answer is only a discarded cause; it is never read.
        await discard(response);
        const code =
          response.status === 401 || response.status === 403
            ? 'provider_unauthorized'
            : response.status >= 500 || response.status === 429
              ? 'provider_unavailable'
              : 'provider_rejected';
        return fail(code, response.status);
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await discard(response);
        return fail('invalid_response', declared);
      }

      let text: string;
      try {
        text = await readCapped(response);
      } catch (error) {
        if (error instanceof ResponseTooLarge) return fail('invalid_response', error);
        return fail('provider_unreachable', error);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error) {
        return fail('invalid_response', error);
      }
      try {
        return interpret(body);
      } catch (error) {
        return fail('invalid_response', error);
      }
    } catch (error) {
      // Only the code and the status leave the adapter; a caller abort is not a provider failure.
      if (error instanceof JobError && !r.signal.aborted) options.onFailure?.(error.code, status);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function chat(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }, format?: unknown) {
    return request(
      {
        path: '/api/chat',
        signal: r.signal,
        timeoutMs,
        body: {
          model: r.model,
          stream: false,
          ...(format === undefined ? {} : { format }),
          options: { temperature: 0 },
          messages: [{ role: 'user', content: r.prompt, images: [Buffer.from(r.image).toString('base64')] }],
        },
      },
      (body) => {
        const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
        if (typeof content !== 'string') throw new TypeError('no message content');
        return content;
      },
    );
  }

  /** The model's capabilities: true/false when reported, null when not or when `show` fails. */
  async function hasVision(model: string, signal: AbortSignal): Promise<boolean | null> {
    try {
      return await request({ path: '/api/show', body: { model }, signal, timeoutMs: SHOW_TIMEOUT_MS }, (body) => {
        const capabilities = (body as { capabilities?: unknown } | null)?.capabilities;
        if (!Array.isArray(capabilities)) return null;
        return capabilities.includes('vision');
      });
    } catch (error) {
      // A caller abort ends the whole list; any other failure only leaves this model unknown.
      if (signal.aborted) throw signal.reason;
      if (error instanceof JobError) return null;
      throw error;
    }
  }

  return {
    async analyzeImage({ image, prompt, schema, model, signal }) {
      const content = await chat({ image, prompt, model, signal }, schema);
      try {
        return JSON.parse(content) as unknown;
      } catch (error) {
        options.onFailure?.('invalid_response', 200);
        throw new JobError('invalid_response', { cause: error });
      }
    },

    describeImage({ image, prompt, model, signal }) {
      return chat({ image, prompt, model, signal });
    },

    async listModels(signal) {
      const names = await request({ path: '/api/tags', signal, timeoutMs }, (body) => {
        const models = (body as { models?: unknown } | null)?.models;
        if (!Array.isArray(models)) throw new TypeError('no model list');
        return models
          .map((entry) => (entry as { name?: unknown } | null)?.name)
          .filter((name): name is string => ModelNameSchema.safeParse(name).success)
          .slice(0, MAX_LISTED_MODELS);
      });

      const vision: (boolean | null)[] = new Array<boolean | null>(names.length).fill(null);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < names.length) {
          const index = next;
          next += 1;
          vision[index] = await hasVision(names[index]!, signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, worker));
      return names.map((name, index) => ({ name, vision: vision[index] ?? null }));
    },
  };
}
