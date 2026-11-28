// Follows the Venice API shape as read from its docs on 2026-11-26 (/image/edit, /image/upscale, /models?type=inpaint).
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { IMAGE_ANSWER_MAX_BYTES, type ImageModel, type JobErrorCode } from '@assetforge/contracts';
import { JobError, type ImageInput, type ImageProvider } from '@assetforge/core';
import { LIST_MODELS_TIMEOUT_MS } from './ollama-vision.js';
import { declaredLength, discard, listCode, nothingSent, paidCode, readCapped, ResponseTooLarge } from './venice-answers.js';
import { modelOf } from './venice-models.js';

/** Upper bound for a model list answer. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 200;

/** The answer types accepted from an edit or upscale; anything else is an unusable answer. */
const ANSWER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const EXTENSIONS: Record<ImageInput['mimeType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface VeniceImageOptions {
  baseUrl: string;
  timeoutMs: number;
  /** The API key in force at call time; null for none. */
  apiKey: () => string | null;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
  fetch?: typeof fetch;
}

/**
 * An `ImageProvider` over Venice's `POST /image/edit`, `POST /image/upscale` and `GET /models?type=inpaint`.
 * The key is sent as a bearer token only to `baseUrl`: redirects are never followed and the key never enters a
 * body, an error or a log. Only the code and the HTTP status of a failure leave the adapter.
 */
export function createVeniceImage(options: VeniceImageOptions): ImageProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  /**
   * Headers with the bearer key read now, or the code of the failure: a key supplier that throws is
   * `internal_error`, a key that cannot be sent cannot authenticate. Neither error is kept: both may quote the key.
   */
  function headers(): Headers | JobErrorCode {
    let key: string | null;
    try {
      key = options.apiKey();
    } catch {
      return 'internal_error';
    }
    try {
      const result = new Headers();
      if (key) result.set('authorization', `Bearer ${key}`);
      return result;
    } catch {
      return 'provider_unauthorized';
    }
  }

  /** One edit or upscale: the answer is handed over as a capped stream; the timeout runs until it ends. */
  async function paid(path: string, form: FormData, callerSignal: AbortSignal): Promise<{ stream: Readable; mimeType: string }> {
    callerSignal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeout.signal]);
    let status: number | null = null;
    let handedOver = false;
    let reported = false;

    // A caller abort is not a provider failure: it rejects with the caller's reason and is not reported.
    const failure = (code: JobErrorCode): unknown => {
      if (callerSignal.aborted) return callerSignal.reason;
      if (!reported) {
        reported = true;
        options.onFailure?.(code, status);
      }
      // No cause: a fetch error may quote the request, and the request carries the key.
      return new JobError(code);
    };

    try {
      const requestHeaders = headers();
      if (typeof requestHeaders === 'string') throw failure(requestHeaders);

      let response: Response;
      try {
        response = await fetchImpl(`${base}${path}`, { method: 'POST', headers: requestHeaders, body: form, signal, redirect: 'manual' });
      } catch (error) {
        // Only a connection that was never made is safe to repeat; anything else may have been charged.
        throw failure(!timeout.signal.aborted && nothingSent(error) ? 'provider_unreachable' : 'provider_outcome_unknown');
      }
      status = response.status;

      const code = paidCode(response);
      if (code !== null) {
        await discard(response);
        throw failure(code);
      }
      const length = declaredLength(response);
      const mimeType = (response.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim().toLowerCase();
      if (!response.body || (length !== null && length > IMAGE_ANSWER_MAX_BYTES) || !ANSWER_TYPES.has(mimeType)) {
        await discard(response);
        throw failure('provider_outcome_unknown');
      }

      const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
      let total = 0;
      const stream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          total += chunk.length;
          if (total > IMAGE_ANSWER_MAX_BYTES) callback(failure('provider_outcome_unknown') as Error);
          else callback(null, chunk);
        },
      });
      // A cut connection, the timeout or a caller abort while the answer streams.
      source.on('error', () => stream.destroy(failure('provider_outcome_unknown') as Error));
      stream.on('close', () => {
        clearTimeout(timer);
        source.destroy();
      });
      source.pipe(stream);
      handedOver = true;
      return { stream, mimeType };
    } finally {
      if (!handedOver) clearTimeout(timer);
    }
  }

  function imagePart(form: FormData, image: ImageInput): void {
    form.append('image', new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mimeType }), `image.${EXTENSIONS[image.mimeType]}`);
  }

  return {
    editImage({ image, model, prompt, aspectRatio, resolution, safeMode, signal }) {
      const form = new FormData();
      imagePart(form, image);
      form.append('prompt', prompt);
      form.append('model', model);
      if (aspectRatio !== null) form.append('aspect_ratio', aspectRatio);
      if (resolution !== null) form.append('resolution', resolution);
      form.append('output_format', 'png');
      form.append('safe_mode', safeMode ? 'true' : 'false');
      return paid('/image/edit', form, signal);
    },

    upscaleImage({ image, scale, signal }) {
      const form = new FormData();
      imagePart(form, image);
      form.append('scale', String(scale));
      return paid('/image/upscale', form, signal);
    },

    async listEditModels(callerSignal) {
      callerSignal.throwIfAborted();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), Math.min(options.timeoutMs, LIST_MODELS_TIMEOUT_MS));
      const signal = AbortSignal.any([callerSignal, deadline.signal]);
      let status: number | null = null;

      const failure = (code: JobErrorCode): unknown => {
        if (callerSignal.aborted) return callerSignal.reason;
        const final = deadline.signal.aborted ? 'provider_timeout' : code;
        options.onFailure?.(final, final === 'provider_timeout' ? null : status);
        return new JobError(final);
      };

      try {
        const requestHeaders = headers();
        if (typeof requestHeaders === 'string') throw failure(requestHeaders);
        let response: Response;
        try {
          response = await fetchImpl(`${base}/models?type=inpaint`, { method: 'GET', headers: requestHeaders, signal, redirect: 'manual' });
        } catch {
          throw failure('provider_unreachable');
        }
        status = response.status;

        const code = listCode(response);
        if (code !== null) {
          await discard(response);
          throw failure(code);
        }
        let text: string;
        try {
          text = await readCapped(response, MAX_LIST_BYTES);
        } catch (error) {
          throw failure(error instanceof ResponseTooLarge ? 'invalid_response' : 'provider_unreachable');
        }
        let data: unknown;
        try {
          data = (JSON.parse(text) as { data?: unknown } | null)?.data;
        } catch {
          throw failure('invalid_response');
        }
        if (!Array.isArray(data)) throw failure('invalid_response');
        return data
          .map(modelOf)
          .filter((model): model is ImageModel => model !== null)
          .slice(0, MAX_MODELS);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
