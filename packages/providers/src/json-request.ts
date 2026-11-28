import type { JobErrorCode } from '@assetforge/contracts';
import { JobError } from '@assetforge/core';
import { discard, readCapped, ResponseTooLarge } from './response-body.js';

/** Upper bound for a provider answer; a tag list is a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The HTTP status of a failed answer, kept beside the error so it never enters a message. */
const statuses = new WeakMap<JobError, number>();

/**
 * Failed requests reject with a JobError; this one also carries the HTTP status for callers that branch on it.
 *
 * @param error what a request rejected with
 * @returns the HTTP status of the failed answer; null for anything else
 */
export function statusOf(error: unknown): number | null {
  return error instanceof JobError ? (statuses.get(error) ?? null) : null;
}

/** What `createJsonRequester` is configured with. */
export interface JsonRequestOptions {
  /** Trailing slashes are dropped. */
  baseUrl: string;
  /** The API key in force at call time; null for none. */
  apiKey?: () => string | null;
  /** Replaces the global fetch, for tests. */
  fetch?: typeof fetch;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
}

/** One request sent through a requester. */
export interface JsonRequest {
  /** Appended to the base URL; starts with '/'. */
  path: string;
  /** Present: POST with this value as JSON. Absent: GET. */
  body?: unknown;
  /** Aborts the request; an abort rejects with its reason and is not reported. */
  signal: AbortSignal;
  /** How long the request may take, including reading the answer. */
  timeoutMs: number;
  /** When true, a failure is not reported through `onFailure`; the caller swallows it. */
  silent?: boolean;
}

/** What every request of one requester shares. */
interface JsonConnection {
  /** The base URL without trailing slashes. */
  base: string;
  /** The fetch, called unbound. */
  fetchImpl: typeof fetch;
  /** The options the requester was created with. */
  options: JsonRequestOptions;
}

/**
 * One request: bearer key, timeout, no redirects, capped answer, the error mapping of every call.
 * Resolves with the parsed JSON body, which `interpret` turns into the result; an error thrown by
 * `interpret` is mapped to `invalid_response` like every other failure. Each failed request is reported once.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 *
 * @param options the base URL, the key supplier, the fetch and the failure report
 * @returns the function that sends one request and interprets its answer
 */
export function createJsonRequester(
  options: JsonRequestOptions,
): <T>(r: JsonRequest, interpret: (body: unknown) => T) => Promise<T> {
  const connection: JsonConnection = {
    base: options.baseUrl.replace(/\/+$/, ''),
    fetchImpl: options.fetch ?? fetch,
    options,
  };
  return (request, interpret) => new JsonCall(connection, request).send(interpret);
}

/**
 * The headers of one request.
 *
 * @param body the request's JSON value; undefined for a GET
 * @param key the API key; null or empty for none
 * @returns the headers
 * @throws JobError `provider_unauthorized` when the key cannot be put into a header
 */
function requestHeaders(body: unknown, key: string | null): Headers {
  try {
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (key) headers.set('authorization', `Bearer ${key}`);
    return headers;
  } catch {
    // The header error quotes the value, so it is never kept: a key that cannot be sent cannot authenticate.
    throw new JobError('provider_unauthorized');
  }
}

/**
 * Whether an answer is a redirect.
 *
 * @param response the answer of a fetch with `redirect: 'manual'`
 * @returns true for an opaque redirect or a 3xx status
 */
function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The code of a failed answer that is not a redirect.
 *
 * @param status the HTTP status
 * @returns `provider_unauthorized` for 401/403, `provider_unavailable` for 5xx and 429, else `provider_rejected`
 */
function failedStatusCode(status: number): JobErrorCode {
  if (status === 401 || status === 403) return 'provider_unauthorized';
  if (status >= 500 || status === 429) return 'provider_unavailable';
  return 'provider_rejected';
}

/** The timeout and the HTTP status of one request. */
class JsonCall {
  /** Aborted when the time limit runs out. */
  private readonly timeout = new AbortController();
  /** The answer's HTTP status once it arrived. */
  private status: number | null = null;

  /**
   * @param connection the base URL, the fetch and the options
   * @param request the path, the body, the signal and the time limit
   */
  constructor(
    private readonly connection: JsonConnection,
    private readonly request: JsonRequest,
  ) {}

  /**
   * Sends the request, reads the answer and interprets it.
   *
   * @param interpret turns the parsed JSON body into the result
   * @returns the result
   */
  async send<T>(interpret: (body: unknown) => T): Promise<T> {
    const r = this.request;
    const { options } = this.connection;
    r.signal.throwIfAborted();
    const timer = setTimeout(() => this.timeout.abort(), r.timeoutMs);
    const combined = AbortSignal.any([r.signal, this.timeout.signal]);

    try {
      // Read per request: a key changed or removed in the settings applies to the next call.
      const key = options.apiKey?.() ?? null;
      const headers = requestHeaders(r.body, key);

      const fetchImpl = this.connection.fetchImpl;
      let response: Response;
      try {
        response = await fetchImpl(`${this.connection.base}${r.path}`, {
          method: r.body === undefined ? 'GET' : 'POST',
          headers,
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
          signal: combined,
          redirect: 'manual',
        });
      } catch {
        // No cause: a fetch error may quote the request, and the request carries the key.
        return this.fail('provider_unreachable', undefined);
      }
      this.status = response.status;

      // A redirect is never followed: the configured base URL is the only address the adapter talks to.
      if (isRedirect(response)) {
        await discard(response);
        return this.fail('provider_rejected', response.status);
      }

      if (!response.ok) {
        // The body of a failed answer is only a discarded cause; it is never read.
        await discard(response);
        return this.fail(failedStatusCode(response.status), response.status);
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await discard(response);
        return this.fail('invalid_response', declared);
      }

      let text: string;
      try {
        text = await readCapped(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof ResponseTooLarge) return this.fail('invalid_response', error);
        return this.fail('provider_unreachable', undefined);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error) {
        return this.fail('invalid_response', error);
      }
      try {
        return interpret(body);
      } catch (error) {
        return this.fail('invalid_response', error);
      }
    } catch (error) {
      // Only the code and the status leave the adapter; a caller abort is not a provider failure.
      if (error instanceof JobError && !r.signal.aborted && !r.silent) options.onFailure?.(error.code, this.status);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Throws the error of a failure. Every failure is mapped after the caller abort and the timeout have been ruled
   * out.
   *
   * @param code the failure's code
   * @param cause kept as the error's cause; never a value that may quote the request
   * @returns never; always throws the caller's abort reason, `provider_timeout` or a `JobError` of `code`
   */
  private fail(code: JobErrorCode, cause: unknown): never {
    const r = this.request;
    if (r.signal.aborted) throw r.signal.reason;
    if (this.timeout.signal.aborted) throw new JobError('provider_timeout', { cause });
    const error = new JobError(code, { cause });
    if (this.status !== null) statuses.set(error, this.status);
    throw error;
  }
}
