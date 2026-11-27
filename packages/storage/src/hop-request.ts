import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { RemoteFile } from '@assetforge/core';
import { limitedBody } from './limited-body.js';
import { failure } from './remote-failure.js';
import { dispositionName, headerText, mediaType, parseContentLength } from './response-headers.js';
import { isChallenge, REDIRECT_STATUSES, statusFailure } from './response-status.js';
import type { Config } from './url-source.js';

/** The headers of one hop besides the fixed ones. */
export interface HopHeaders {
  userAgent: string;
  cookie: string | null;
}

export type HopOutcome = { kind: 'file'; file: RemoteFile } | { kind: 'redirect'; location: string | undefined };

export function fetchHop(
  url: URL,
  address: string,
  headers: HopHeaders,
  config: Config,
  signal: AbortSignal,
  deadline: number,
  hopDeadline: number,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve, reject) => {
    // A listener added to an aborted signal never fires, so an aborted hop sends no request.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const family = net.isIP(address);
    const pinnedLookup: net.LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const req = (url.protocol === 'https:' ? https : http).request({
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
        req.destroy();
        reject(error);
      });
    const onAbort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(failure('unreachable')), Math.max(0, hopDeadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => fail(failure('unreachable')));

    req.on('response', (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const status = res.statusCode ?? 0;
      const mitigated = headerText(res.headers['cf-mitigated']);
      // A browser challenge is a failure whatever the status, a redirect or a 200 included.
      if (status !== 200 || isChallenge(mitigated)) {
        res.destroy();
        if (REDIRECT_STATUSES.has(status) && !isChallenge(mitigated)) {
          settle(() => {
            req.destroy();
            resolve({ kind: 'redirect', location: res.headers.location });
          });
        } else {
          fail(statusFailure(status, { retryAfter: res.headers['retry-after'], mitigated }));
        }
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
        res.destroy();
        fail(failure('rejected'));
        return;
      }
      const contentLength = parseContentLength(res.headers['content-length']);
      if (contentLength !== null && contentLength > config.maxBytes) {
        res.destroy();
        fail(failure('too_large'));
        return;
      }
      settle(() =>
        resolve({
          kind: 'file',
          file: {
            stream: limitedBody(
              { destroy: () => req.destroy(), onError: (listener) => req.on('error', listener) },
              res,
              config,
              signal,
              deadline,
              contentLength,
            ),
            finalUrl: url.href,
            contentType: mediaType(res.headers['content-type']),
            contentLength,
            dispositionName: dispositionName(res.headers['content-disposition']),
          },
        }),
      );
    });
    req.end();
  });
}
export function bareHost(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

