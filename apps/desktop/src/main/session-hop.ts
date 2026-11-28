import type { RemoteFile, RemoteFileError } from '@assetforge/core';
import {
  dispositionName,
  headerText,
  isChallenge,
  limitedBody,
  mediaType,
  parseContentLength,
  statusFailure,
  type BodyLimits,
} from '@assetforge/storage';
import { failure } from './session-failure.js';
import type { SessionNetRequest, SessionNetResponse } from './session-request.js';

// One hop of a session download: a single GET through the profile's browser session. Nothing here logs, and no error
// carries a URL, an address, a header or a cause.

/** What one session hop asks for: the URL, the profile whose session sends it and how the request is made. */
export interface SessionHopTarget {
  url: URL;
  profileId: string;
  /** Starts one GET through the profile's session without following redirects; may throw. */
  request(profileId: string, url: string): SessionNetRequest;
}

/** What bounds one session hop: the body limits, the abort signal and the two deadlines (ms since the epoch). */
export interface SessionHopBounds {
  limits: BodyLimits;
  /** Aborts the hop and its body with its reason. */
  signal: AbortSignal;
  /** The end of the whole download; the body fails `unreachable` after it. */
  deadline: number;
  /** The time by which the answer's headers must have arrived. */
  hopDeadline: number;
}

/** How a hop ended: with the file, or with the target of a redirect. */
export type HopOutcome = { kind: 'file'; file: RemoteFile } | { kind: 'redirect'; location: string | undefined };

/** What the headers of an answer decide before its body is read. */
type ResponseVerdict = { kind: 'file'; contentLength: number | null } | { kind: 'failed'; error: RemoteFileError };

/**
 * Ends a session request, ignoring a request that already ended.
 *
 * @param request the request to abort
 */
function abortQuietly(request: SessionNetRequest): void {
  try {
    request.abort();
  } catch {
    // Already ended.
  }
}

/**
 * Sends one hop through the profile's session. A redirect is not followed: the request is aborted inside the
 * redirect event (Electron fails a manual redirect that is neither followed nor aborted there) and its target
 * becomes the next hop. The statuses map exactly like the Node source's, a browser challenge first.
 *
 * @param target the URL, the profile and the request factory
 * @param bounds the body limits, the abort signal and the deadlines
 * @returns the file, or the redirect target; rejects with a `RemoteFileError` or the abort reason
 */
export function sessionHop(target: SessionHopTarget, bounds: SessionHopBounds): Promise<HopOutcome> {
  const { signal } = bounds;
  return new Promise<HopOutcome>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let request: SessionNetRequest;
    try {
      request = target.request(target.profileId, target.url.href);
    } catch {
      reject(failure('unreachable'));
      return;
    }

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
        abortQuietly(request);
        reject(error);
      });
    const onAbort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(failure('unreachable')), Math.max(0, bounds.hopDeadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('error', () => fail(failure('unreachable')));

    request.on('redirect', (status, _method, redirectUrl, headers) => {
      const mitigated = headerText(headers['cf-mitigated']);
      if (isChallenge(mitigated)) {
        fail(statusFailure(status, { mitigated }));
        return;
      }
      settle(() => {
        abortQuietly(request);
        resolve({ kind: 'redirect', location: redirectUrl });
      });
      // A redirect that arrives after the hop ended is still aborted, so Electron raises no error of its own.
      abortQuietly(request);
    });

    request.on('response', (response) => {
      if (isSettled) {
        response.destroy();
        return;
      }
      const verdict = judgeResponse(response, bounds.limits.maxBytes);
      if (verdict.kind === 'failed') {
        response.destroy();
        fail(verdict.error);
        return;
      }
      settle(() =>
        resolve({ kind: 'file', file: responseFile(request, response, target.url, verdict.contentLength, bounds) }),
      );
    });
    request.end();
  });
}

/**
 * Decides from the headers of an answer (not a redirect) what the hop is.
 *
 * @param response the answer
 * @param maxBytes the size limit an announced length is checked against
 * @returns a file with its announced length, or the failure
 */
function judgeResponse(response: SessionNetResponse, maxBytes: number): ResponseVerdict {
  const status = response.statusCode;
  const mitigated = headerText(response.headers['cf-mitigated']);
  if (status !== 200 || isChallenge(mitigated)) {
    return {
      kind: 'failed',
      error: statusFailure(status, { retryAfter: headerText(response.headers['retry-after']), mitigated }),
    };
  }
  // Chromium decodes a compressed body itself; its announced length is then not the length that arrives.
  const encoding = headerText(response.headers['content-encoding']);
  const isIdentity = encoding === undefined || encoding.trim() === '' || encoding.trim().toLowerCase() === 'identity';
  const contentLength = isIdentity ? parseContentLength(headerText(response.headers['content-length'])) : null;
  if (contentLength !== null && contentLength > maxBytes) return { kind: 'failed', error: failure('too_large') };
  return { kind: 'file', contentLength };
}

/**
 * The file of an answer that is one, its body read under the limits.
 *
 * @param request the request of the hop; aborted with the body
 * @param response the answer
 * @param url the hop, which becomes the file's final URL
 * @param contentLength the announced length; null when unknown or when the body is decoded
 * @param bounds the body limits, the abort signal and the download's deadline
 * @returns the remote file
 */
function responseFile(
  request: SessionNetRequest,
  response: SessionNetResponse,
  url: URL,
  contentLength: number | null,
  bounds: SessionHopBounds,
): RemoteFile {
  return {
    stream: limitedBody(
      { destroy: () => abortQuietly(request), onError: (listener) => request.on('error', listener) },
      response,
      bounds.limits,
      bounds.signal,
      bounds.deadline,
      contentLength,
    ),
    finalUrl: url.href,
    contentType: mediaType(headerText(response.headers['content-type'])),
    contentLength,
    dispositionName: dispositionName(headerText(response.headers['content-disposition'])),
  };
}
