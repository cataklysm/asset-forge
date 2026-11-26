// Follows the Venice API shape as read from its docs on 2026-11-26 (/image/edit, /image/upscale, /models?type=inpaint).
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { IMAGE_ANSWER_MAX_BYTES, ImageModelSchema, ModelNameSchema, type ImageModel, type JobErrorCode } from '@assetforge/contracts';
import { JobError, type ImageInput, type ImageProvider } from '@assetforge/core';
import { LIST_MODELS_TIMEOUT_MS } from './ollama-vision.js';

/** Upper bound for a model list answer. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 200;
const VIOLATION_HEADER = 'x-venice-is-content-violation';

/** Codes that mean the connection was never made, so nothing was sent and nothing can have been charged. */
const NOTHING_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

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

/** True when a `NOTHING_SENT` code appears anywhere in the cause chain (or in the attempts of an `AggregateError`). */
function nothingSent(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 32) {
    const current = queue.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const { code, cause, errors } = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string' && NOTHING_SENT.has(code)) return true;
    queue.push(cause);
    if (Array.isArray(errors)) queue.push(...(errors as unknown[]));
  }
  return false;
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The code of an edit or upscale answer, or null when it can be used. A request that may have been charged
 * and did not deliver is `provider_outcome_unknown` and is never repeated.
 */
function paidCode(response: Response): JobErrorCode | null {
  if (response.headers.get(VIOLATION_HEADER)?.trim().toLowerCase() === 'true') return 'provider_content_refused';
  if (isRedirect(response)) return 'provider_rejected';
  const status = response.status;
  if (response.ok) return null;
  if (status === 401 || status === 403) return 'provider_unauthorized';
  if (status === 402) return 'provider_insufficient_balance';
  if (status === 422) return 'provider_content_refused';
  if (status === 429 || status === 503) return 'provider_unavailable';
  if (status >= 400 && status < 500) return 'provider_rejected';
  return 'provider_outcome_unknown';
}

/** The code of a model list answer (not charged), or null when it can be used. */
function listCode(response: Response): JobErrorCode | null {
  if (isRedirect(response)) return 'provider_rejected';
  if (response.ok) return null;
  if (response.status === 401 || response.status === 403) return 'provider_unauthorized';
  if (response.status === 429 || response.status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

/** Releases a body that will not be read. Failures are irrelevant: the answer is already decided. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignored
  }
}

function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

class ResponseTooLarge extends Error {}

/** Reads the body as UTF-8 and stops (cancelling the stream) once it exceeds `limit`. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
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

function constraintList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  if (!value.every((entry) => typeof entry === 'string' && entry.length >= 1 && entry.length <= 20)) return null;
  return [...(value as string[])];
}

function usdOf(value: unknown): number | null {
  const usd = (value as { usd?: unknown } | null)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/** The display text of the USD value of `pricing` (on the object itself or one level below), else null. */
function priceOf(pricing: unknown): string | null {
  if (pricing === null || typeof pricing !== 'object') return null;
  const usd = usdOf(pricing) ?? Object.values(pricing).map(usdOf).find((value) => value !== null) ?? null;
  if (usd === null) return null;
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function modelOf(entry: unknown): ImageModel | null {
  if (entry === null || typeof entry !== 'object') return null;
  const { id, model_spec: spec } = entry as { id?: unknown; model_spec?: unknown };
  const name = ModelNameSchema.safeParse(id);
  if (!name.success) return null;
  const { constraints, pricing } = (spec !== null && typeof spec === 'object' ? spec : {}) as { constraints?: unknown; pricing?: unknown };
  const c = (constraints !== null && typeof constraints === 'object' ? constraints : {}) as Record<string, unknown>;
  const defaultResolution = c.defaultResolution;
  const limit = c.promptCharacterLimit;
  const model = {
    name: name.data,
    aspectRatios: constraintList(c.aspectRatios),
    resolutions: constraintList(c.resolutions),
    defaultResolution:
      typeof defaultResolution === 'string' && defaultResolution.length >= 1 && defaultResolution.length <= 20 ? defaultResolution : null,
    promptCharacterLimit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    price: priceOf(pricing),
  };
  const parsed = ImageModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

/**
 * An `ImageProvider` over Venice's `POST /image/edit`, `POST /image/upscale` and `GET /models?type=inpaint`.
 * The key is sent as a bearer token only to `baseUrl`: redirects are never followed and the key never enters a
 * body, an error or a log. Only the code and the HTTP status of a failure leave the adapter.
 */
export function createVeniceImage(options: VeniceImageOptions): ImageProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  /** Headers with the bearer key read now; a key that cannot be sent cannot authenticate. */
  function headers(): Headers | null {
    const key = options.apiKey();
    try {
      const result = new Headers();
      if (key) result.set('authorization', `Bearer ${key}`);
      return result;
    } catch {
      // The header error quotes the value, so it is never kept.
      return null;
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
      if (requestHeaders === null) throw failure('provider_unauthorized');

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
      if (!response.body || (length !== null && length > IMAGE_ANSWER_MAX_BYTES) || !mimeType.startsWith('image/')) {
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
        if (requestHeaders === null) throw failure('provider_unauthorized');
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
