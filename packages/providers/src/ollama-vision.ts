import { JobError, type VisionProvider } from '@assetforge/core';

export const OLLAMA_PROVIDER = 'ollama';

const DEFAULT_TIMEOUT_MS = 120_000;

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
          });
        } catch (error) {
          return fail('provider_unreachable', error);
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          return fail('provider_unreachable', error);
        }

        if (!response.ok) {
          const code = response.status >= 500 || response.status === 429 ? 'provider_unavailable' : 'provider_rejected';
          throw new JobError(code, { cause: text });
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
