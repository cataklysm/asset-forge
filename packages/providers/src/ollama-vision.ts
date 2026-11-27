import { ModelNameSchema, type JobErrorCode, type VisionRequestOptions } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import { createJsonRequester } from './json-request.js';
import { composeBody, DEFAULT_REQUEST_OPTIONS, ollamaFixedFields } from './request-options.js';

export const OLLAMA_PROVIDER = 'ollama';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Keys of an Ollama chat body whose objects `extra` merges into rather than replaces. */
const OLLAMA_DEEP_KEYS = ['options'] as const;

/** `listModels` asks `/api/show` for at most this many models, this many at a time, each within its own limit. */
const MAX_LISTED_MODELS = 100;
const SHOW_CONCURRENCY = 4;
const SHOW_TIMEOUT_MS = 10_000;

/** Upper bound for the whole `listModels` call (`/api/tags` plus every `/api/show`). */
export const LIST_MODELS_TIMEOUT_MS = 10_000;

/** Largest delay `setTimeout` accepts; the deadline of `listModels` is the real bound of its `/api/tags` call. */
const MAX_TIMER_MS = 2_147_483_647;

export interface OllamaVisionOptions {
  baseUrl: string;
  /** The API key in force at call time; null for none. */
  apiKey?: () => string | null;
  timeoutMs?: number;
  /** Bound for the whole `listModels` call; default `min(timeoutMs, LIST_MODELS_TIMEOUT_MS)`. */
  listTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
  /** Temperature, length, thinking and extra fields of every chat request; default `DEFAULT_REQUEST_OPTIONS`. */
  requestOptions?: VisionRequestOptions;
}

/**
 * A `VisionProvider` over Ollama's `POST /api/chat`, `GET /api/tags` and `POST /api/show`.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 */
export function createOllamaVision(options: OllamaVisionOptions): VisionProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listTimeoutMs = options.listTimeoutMs ?? Math.min(timeoutMs, LIST_MODELS_TIMEOUT_MS);
  const requestOptions = options.requestOptions ?? DEFAULT_REQUEST_OPTIONS;
  const fixed = ollamaFixedFields(requestOptions);
  const request = createJsonRequester(options);

  function chat(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }, format?: unknown) {
    return request(
      {
        path: '/api/chat',
        signal: r.signal,
        timeoutMs,
        // The adapter's own fields come last: `extra` can never change the model, the stream or the format.
        body: composeBody(
          fixed,
          requestOptions.extra,
          {
            model: r.model,
            stream: false,
            ...(format === undefined ? {} : { format }),
            messages: [{ role: 'user', content: r.prompt, images: [Buffer.from(r.image).toString('base64')] }],
          },
          OLLAMA_DEEP_KEYS,
        ),
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
      // Silent: a failed show is not a provider failure, it only leaves this model unknown.
      const show = { path: '/api/show', body: { model }, signal, timeoutMs: SHOW_TIMEOUT_MS, silent: true } as const;
      return await request(show, (body) => {
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

    async listModels(callerSignal) {
      callerSignal.throwIfAborted();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), listTimeoutMs);
      const signal = AbortSignal.any([callerSignal, deadline.signal]);
      try {
        const names = await request({ path: '/api/tags', signal, timeoutMs: MAX_TIMER_MS }, (body) => {
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
      } catch (error) {
        // A caller abort stays as it is; an expired deadline is one timeout, reported once.
        if (!callerSignal.aborted && deadline.signal.aborted) {
          options.onFailure?.('provider_timeout', null);
          throw new JobError('provider_timeout');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
