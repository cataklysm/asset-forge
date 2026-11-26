import { JobError, type VisionProvider } from '@assetforge/core';

export const OLLAMA_PROVIDER = 'ollama';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Upper bound for a provider answer; a tag list is a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A `VisionProvider` over Ollama's `POST /api/chat`. No authentication in phase 4a. */
export function createOllamaVision(options: OllamaVisionOptions): VisionProvider {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/chat`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async analyzeImage({ image, prompt, schema, signal }) {
      signal.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const combined = AbortSignal.any([signal, timeout.signal]);

      // Every failure is mapped after the caller abort and the timeout have been ruled out.
      const fail = (code: 'provider_unreachable' | 'invalid_response', cause: unknown): never => {
        if (signal.aborted) throw signal.reason;
        if (timeout.signal.aborted) throw new JobError('provider_timeout', { cause });
        throw new JobError(code, { cause });
      };

      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: options.model,
              stream: false,
              format: schema,
              options: { temperature: 0 },
              messages: [{ role: 'user', content: prompt, images: [Buffer.from(image).toString('base64')] }],
            }),
            signal: combined,
            redirect: 'manual',
          });
        } catch (error) {
          return fail('provider_unreachable', error);
        }

        // A redirect is never followed: the configured base URL is the only address the adapter talks to.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          await discard(response);
          throw new JobError('provider_rejected', { cause: response.status });
        }

        if (!response.ok) {
          // The body of a failed answer is only a discarded cause; it is never read.
          await discard(response);
          const code = response.status >= 500 || response.status === 429 ? 'provider_unavailable' : 'provider_rejected';
          throw new JobError(code, { cause: response.status });
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
        const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
        if (typeof content !== 'string') return fail('invalid_response', text);
        try {
          return JSON.parse(content) as unknown;
        } catch (error) {
          return fail('invalid_response', error);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
