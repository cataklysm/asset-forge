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
 * @returns the headers; null when the key cannot be put into a header
 */
function requestHeaders(body: unknown, key: string | null): Headers | null {
  try {
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (key) headers.set('authorization', `Bearer ${key}`);
    return headers;
  } catch {
    return null;
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
    const request = this.request;
    request.signal.throwIfAborted();
    const timer = setTimeout(() => this.timeout.abort(), request.timeoutMs);
    try {
      const response = await this.answer(AbortSignal.any([request.signal, this.timeout.signal]));
      const body = await this.readBody(response);
      try {
        return interpret(body);
      } catch {
        // No cause: the interpreter's message may quote the answer.
        return this.fail('invalid_response');
      }
    } catch (error) {
      // Only the code and the status leave the adapter; a caller abort is not a provider failure.
      if (error instanceof JobError && !request.signal.aborted && !request.silent) {
        this.connection.options.onFailure?.(error.code, this.status);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends the request and takes the answer when it is a success; a redirect or a failed status fails the call.
   *
   * @param signal the caller's signal combined with the timeout
   * @returns the successful answer, its body not yet read
   */
  private async answer(signal: AbortSignal): Promise<Response> {
    const request = this.request;
    // Read per request: a key changed or removed in the settings applies to the next call.
    const headers = requestHeaders(request.body, this.connection.options.apiKey?.() ?? null);
    // The header error quotes the value, so it is never kept: a key that cannot be sent cannot authenticate.
    if (headers === null) return this.fail('provider_unauthorized');
    let response: Response;
    try {
      response = await this.connection.fetchImpl(`${this.connection.base}${request.path}`, {
        method: request.body === undefined ? 'GET' : 'POST',
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
        redirect: 'manual',
      });
    } catch {
      // No cause: a fetch error may quote the request, and the request carries the key.
      return this.fail('provider_unreachable');
    }
    this.status = response.status;
    // A redirect is never followed: the configured base URL is the only address the adapter talks to.
    if (isRedirect(response)) {
      await discard(response);
      return this.fail('provider_rejected');
    }
    if (!response.ok) {
      // The body of a failed answer is never read.
      await discard(response);
      return this.fail(failedStatusCode(response.status));
    }
    return response;
  }

  /**
   * Reads a successful answer within `MAX_RESPONSE_BYTES` and parses it as JSON.
   *
   * @param response the successful answer
   * @returns the parsed body
   */
  private async readBody(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await discard(response);
      return this.fail('invalid_response');
    }
    let text: string;
    try {
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLarge) return this.fail('invalid_response');
      return this.fail('provider_unreachable');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // No cause: a parse error's message can quote part of the answer.
      return this.fail('invalid_response');
    }
  }

  /**
   * Throws the error of a failure. A caller abort always wins; the timeout only replaces a transport failure, which
   * is what its abort causes, so an answer that arrived keeps the code it earned even when the timer fired since.
   *
   * The error never carries a cause: what went wrong may quote the request, which carries the key, or the answer.
   *
   * @param code the failure's code
   * @returns never; always throws the caller's abort reason, `provider_timeout` or a `JobError` of `code`
   */
  private fail(code: JobErrorCode): never {
    const request = this.request;
    if (request.signal.aborted) throw request.signal.reason;
    if (code === 'provider_unreachable' && this.timeout.signal.aborted) throw new JobError('provider_timeout');
    const error = new JobError(code);
    if (this.status !== null) statuses.set(error, this.status);
    throw error;
  }
}
