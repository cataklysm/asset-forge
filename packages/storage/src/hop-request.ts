import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { RemoteFile, RemoteFileError } from '@assetforge/core';
import { limitedBody, type BodyLimits } from './limited-body.js';
import { failure } from './remote-failure.js';
import { dispositionName, headerText, mediaType, parseContentLength } from './response-headers.js';
import { isChallenge, REDIRECT_STATUSES, statusFailure } from './response-status.js';

// One hop of the URL source: a single GET over Node's `http`/`https`, its socket pinned to the address the hop
// loop vetted, while `Host`, SNI and the certificate check use the host name.

/** The headers of one hop besides the fixed ones. */
export interface HopHeaders {
  /** Sent as `User-Agent`. */
  userAgent: string;
  /** Sent as `Cookie`; null sends none. */
  cookie: string | null;
}

/** What one hop asks for: the URL, the vetted address it connects to and its headers. */
export interface HopTarget {
  url: URL;
  /** The address the socket connects to; already vetted. */
  address: string;
  headers: HopHeaders;
}

/** What bounds one hop: the body limits, the abort signal and the two deadlines (ms since the epoch). */
export interface HopBounds {
  limits: BodyLimits;
  /** Aborts the hop and its body with its reason. */
  signal: AbortSignal;
  /** The end of the whole download; the body fails `unreachable` after it. */
  deadline: number;
  /** The time by which the answer's headers must have arrived. */
  hopDeadline: number;
}

/** How a hop ended: with the file, or with the target of a redirect (undefined when it named none). */
export type HopOutcome = { kind: 'file'; file: RemoteFile } | { kind: 'redirect'; location: string | undefined };

/** What the headers of an answer decide before its body is read. */
type ResponseVerdict =
  | { kind: 'file'; contentLength: number | null }
  | { kind: 'redirect'; location: string | undefined }
  | { kind: 'failed'; error: RemoteFileError };

/**
 * The host of a URL without the brackets of an IPv6 literal.
 *
 * @param url the hop
 * @returns the host name or address as the resolver and the socket take it
 */
export function bareHost(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Sends one hop and waits for the headers of its answer. A redirect is not followed here: its target is answered
 * and the hop loop vets it as the next hop. The request ends when the hop fails, redirects or its body ends.
 *
 * @param target the URL, the vetted address and the headers
 * @param bounds the body limits, the abort signal and the deadlines
 * @returns the file with its body still to be read, or the redirect target; rejects with a `RemoteFileError` or the
 *   abort reason
 */
export function fetchHop(target: HopTarget, bounds: HopBounds): Promise<HopOutcome> {
  const { signal } = bounds;
  return new Promise<HopOutcome>((resolve, reject) => {
    // A listener added to an aborted signal never fires, so an aborted hop sends no request.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const request = startRequest(target);

    let isSettled = false;
    const settle = (done: () => void) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      done();
    };
    const fail = (error: unknown) =>
      settle(() => {
        request.destroy();
        reject(error);
      });
    const onAbort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(failure('unreachable')), Math.max(0, bounds.hopDeadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('error', () => fail(failure('unreachable')));

    request.on('response', (response) => {
      if (isSettled) {
        response.destroy();
        return;
      }
      const verdict = judgeResponse(response, bounds.limits.maxBytes);
      if (verdict.kind === 'file') {
        settle(() => resolve({ kind: 'file', file: responseFile(request, response, target.url, verdict.contentLength, bounds) }));
        return;
      }
      response.destroy();
      if (verdict.kind === 'failed') {
        fail(verdict.error);
        return;
      }
      settle(() => {
        request.destroy();
        resolve(verdict);
      });
    });
    request.end();
  });
}

/**
 * Creates the GET of one hop. The lookup answers only the vetted address, so the socket cannot reach another one;
 * `agent: false` keeps the connection to this one request. Only `User-Agent`, `Accept`, `Accept-Encoding` and the
 * cookie of the hop are sent.
 *
 * @param target the URL, the vetted address and the headers
 * @returns the request, not yet ended
 */
function startRequest(target: HopTarget): http.ClientRequest {
  const { url, address, headers } = target;
  const family = net.isIP(address);
  const pinnedLookup: net.LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return (url.protocol === 'https:' ? https : http).request({
    protocol: url.protocol,
    hostname: bareHost(url),
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    agent: false,
    lookup: pinnedLookup,
    headers: {
      'User-Agent': headers.userAgent,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...(headers.cookie === null ? {} : { Cookie: headers.cookie }),
    },
  });
}

/**
 * Decides from the headers of an answer what the hop is.
 *
 * @param response the answer
 * @param maxBytes the size limit an announced length is checked against
 * @returns a file with its announced length, a redirect, or the failure
 */
function judgeResponse(response: http.IncomingMessage, maxBytes: number): ResponseVerdict {
  const status = response.statusCode ?? 0;
  const mitigated = headerText(response.headers['cf-mitigated']);
  // A browser challenge is a failure whatever the status, a redirect or a 200 included.
  if (status !== 200 || isChallenge(mitigated)) {
    if (REDIRECT_STATUSES.has(status) && !isChallenge(mitigated)) {
      return { kind: 'redirect', location: response.headers.location };
    }
    return { kind: 'failed', error: statusFailure(status, { retryAfter: response.headers['retry-after'], mitigated }) };
  }
  const encoding = response.headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
    return { kind: 'failed', error: failure('rejected') };
  }
  const contentLength = parseContentLength(response.headers['content-length']);
  if (contentLength !== null && contentLength > maxBytes) return { kind: 'failed', error: failure('too_large') };
  return { kind: 'file', contentLength };
}

/**
 * The file of an answer that is one, its body read under the limits.
 *
 * @param request the request of the hop; destroyed with the body
 * @param response the answer
 * @param url the hop, which becomes the file's final URL
 * @param contentLength the announced length; null when unknown
 * @param bounds the body limits, the abort signal and the download's deadline
 * @returns the remote file
 */
function responseFile(
  request: http.ClientRequest,
  response: http.IncomingMessage,
  url: URL,
  contentLength: number | null,
  bounds: HopBounds,
): RemoteFile {
  return {
    stream: limitedBody(
      { destroy: () => request.destroy(), onError: (listener) => request.on('error', listener) },
      response,
      bounds.limits,
      bounds.signal,
      bounds.deadline,
      contentLength,
    ),
    finalUrl: url.href,
    contentType: mediaType(response.headers['content-type']),
    contentLength,
    dispositionName: dispositionName(response.headers['content-disposition']),
  };
}
