import type { RemoteFile } from '@assetforge/core';
import { dispositionName, headerText, isChallenge, limitedBody, mediaType, parseContentLength, statusFailure } from '@assetforge/storage';
import type { SessionNetRequest } from './session-request.js';
import { failure, type Config } from './site-download.js';

export type HopOutcome = { kind: 'file'; file: RemoteFile } | { kind: 'redirect'; location: string | undefined };

/**
 * Ends a session request, ignoring a request that already ended.
 *
 * @param req the request to abort
 * @returns nothing
 */
function abortQuietly(req: SessionNetRequest): void {
  try {
    req.abort();
  } catch {
    // Already ended.
  }
}

/**
 * Sends one hop through the profile's session. A redirect is not followed: the request is aborted inside the
 * redirect event (Electron fails a manual redirect that is neither followed nor aborted there) and its target
 * becomes the next hop. The statuses map exactly like the Node source's, a browser challenge first.
 *
 * @param url the hop
 * @param profileId the profile whose session sends it
 * @param config the request factory and the limits
 * @param signal aborts the hop and the body with its reason
 * @param deadline the end of the whole download
 * @param hopDeadline the time by which the answer's headers must have arrived
 * @returns the file, or the redirect target
 */
export function sessionHop(
  url: URL,
  profileId: string,
  config: Config,
  signal: AbortSignal,
  deadline: number,
  hopDeadline: number,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let req: SessionNetRequest;
    try {
      req = config.request(profileId, url.href);
    } catch {
      reject(failure('unreachable'));
      return;
    }

    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      done();
    };
    const fail = (error: unknown) =>
      settle(() => {
        abortQuietly(req);
        reject(error);
      });
    const onAbort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(failure('unreachable')), Math.max(0, hopDeadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => fail(failure('unreachable')));

    req.on('redirect', (status, _method, redirectUrl, headers) => {
      const mitigated = headerText(headers['cf-mitigated']);
      if (isChallenge(mitigated)) {
        fail(statusFailure(status, { mitigated }));
        return;
      }
      settle(() => {
        abortQuietly(req);
        resolve({ kind: 'redirect', location: redirectUrl });
      });
      // A redirect that arrives after the hop ended is still aborted, so Electron raises no error of its own.
      abortQuietly(req);
    });

    req.on('response', (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const status = res.statusCode;
      const mitigated = headerText(res.headers['cf-mitigated']);
      if (status !== 200 || isChallenge(mitigated)) {
        res.destroy();
        fail(statusFailure(status, { retryAfter: headerText(res.headers['retry-after']), mitigated }));
        return;
      }
      // Chromium decodes a compressed body itself; its announced length is then not the length that arrives.
      const encoding = headerText(res.headers['content-encoding']);
      const identity = encoding === undefined || encoding.trim() === '' || encoding.trim().toLowerCase() === 'identity';
      const contentLength = identity ? parseContentLength(headerText(res.headers['content-length'])) : null;
      if (contentLength !== null && contentLength > config.limits.maxBytes) {
        res.destroy();
        fail(failure('too_large'));
        return;
      }
      settle(() =>
        resolve({
          kind: 'file',
          file: {
            stream: limitedBody(
              { destroy: () => abortQuietly(req), onError: (listener) => req.on('error', listener) },
              res,
              config.limits,
              signal,
              deadline,
              contentLength,
            ),
            finalUrl: url.href,
            contentType: mediaType(headerText(res.headers['content-type'])),
            contentLength,
            dispositionName: dispositionName(headerText(res.headers['content-disposition'])),
          },
        }),
      );
    });
    req.end();
  });
}
