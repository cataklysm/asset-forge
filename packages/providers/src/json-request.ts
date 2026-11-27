import type { JobErrorCode } from '@assetforge/contracts';
import { JobError } from '@assetforge/core';

/** Upper bound for a provider answer; a tag list is a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

class ResponseTooLarge extends Error {}

/** The HTTP status of a failed answer, kept beside the error so it never enters a message. */
const statuses = new WeakMap<JobError, number>();

/** Failed requests reject with a JobError; this one also carries the HTTP status for callers that branch on it. */
export function statusOf(error: unknown): number | null {
  return error instanceof JobError ? (statuses.get(error) ?? null) : null;
}

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

export interface JsonRequestOptions {
  /** Trailing slashes are dropped. */
  baseUrl: string;
  /** The API key in force at call time; null for none. */
  apiKey?: () => string | null;
  fetch?: typeof fetch;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
}

export interface JsonRequest {
  /** Appended to the base URL; starts with '/'. */
  path: string;
  /** Present: POST with this value as JSON. Absent: GET. */
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  /** When true, a failure is not reported through `onFailure`; the caller swallows it. */
  silent?: boolean;
}

/**
 * One request: bearer key, timeout, no redirects, capped answer, the error mapping of every call.
 * Resolves with the parsed JSON body, which `interpret` turns into the result; an error thrown by
 * `interpret` is mapped to `invalid_response` like every other failure. Each failed request is reported once.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 */
export function createJsonRequester(
  options: JsonRequestOptions,
): <T>(r: JsonRequest, interpret: (body: unknown) => T) => Promise<T> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  return async function request<T>(r: JsonRequest, interpret: (body: unknown) => T): Promise<T> {
    r.signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), r.timeoutMs);
    const combined = AbortSignal.any([r.signal, timeout.signal]);
    let status: number | null = null;

    // Every failure is mapped after the caller abort and the timeout have been ruled out.
    const fail = (code: JobErrorCode, cause: unknown): never => {
      if (r.signal.aborted) throw r.signal.reason;
      if (timeout.signal.aborted) throw new JobError('provider_timeout', { cause });
      const error = new JobError(code, { cause });
      if (status !== null) statuses.set(error, status);
      throw error;
    };

    try {
      // Read per request: a key changed or removed in the settings applies to the next call.
      const key = options.apiKey?.() ?? null;
      let headers: Headers;
      try {
        headers = new Headers();
        if (r.body !== undefined) headers.set('content-type', 'application/json');
        if (key) headers.set('authorization', `Bearer ${key}`);
      } catch {
        // The header error quotes the value, so it is never kept: a key that cannot be sent cannot authenticate.
        throw new JobError('provider_unauthorized');
      }

      let response: Response;
      try {
        response = await fetchImpl(`${base}${r.path}`, {
          method: r.body === undefined ? 'GET' : 'POST',
          headers,
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
          signal: combined,
          redirect: 'manual',
        });
      } catch {
        // No cause: a fetch error may quote the request, and the request carries the key.
        return fail('provider_unreachable', undefined);
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
        return fail('provider_unreachable', undefined);
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
      if (error instanceof JobError && !r.signal.aborted && !r.silent) options.onFailure?.(error.code, status);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
