import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import {
  clampRetryAfterMs,
  DOWNLOAD_HEADER_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  DOWNLOAD_TOTAL_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_REDIRECTS,
  RemoteFileError,
  type RemoteFile,
  type RemoteFileFailure,
  type RemoteFileSource,
} from '@assetforge/core';
import { isPublicAddress } from './public-address.js';

export interface UrlSourceOptions {
  /** Sent as `User-Agent`, e.g. `AssetForge/<version>`. */
  userAgent: string;
  /** The address policy; defaults to `isPublicAddress`. Only tests pass another one. */
  allowAddress?: (address: string) => boolean;
  /** Resolves a host name to its addresses; defaults to the system resolver (all addresses). */
  lookup?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
}

interface Config {
  userAgent: string;
  allowAddress: (address: string) => boolean;
  lookup: (host: string) => Promise<string[]>;
  maxBytes: number;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_STATUSES = new Set([401, 403, 407, 451]);
const NOT_FOUND_STATUSES = new Set([404, 410]);

/** A failure without a cause: a cause could carry the URL or an address. */
function failure(kind: RemoteFileFailure, retryAfterMs: number | null = null): RemoteFileError {
  return new RemoteFileError(kind, retryAfterMs);
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address);
}

/**
 * The network side of the URL import over Node's `http`/`https`. Every hop passes the scheme and user-info rule and
 * the address check (every resolved address must pass `allowAddress`); the socket connects to exactly the checked address while
 * `Host`, SNI and the certificate check use the host name. Redirects are followed by hand. Nothing is logged.
 */
export function createUrlSource(options: UrlSourceOptions): RemoteFileSource {
  const config: Config = {
    userAgent: options.userAgent,
    allowAddress: options.allowAddress ?? isPublicAddress,
    lookup: options.lookup ?? systemLookup,
    maxBytes: options.maxBytes ?? MAX_DOWNLOAD_BYTES,
    headerTimeoutMs: options.headerTimeoutMs ?? DOWNLOAD_HEADER_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? MAX_DOWNLOAD_REDIRECTS,
  };
  return { open: (url, signal) => openUrl(url, signal, config) };
}

async function openUrl(input: string, signal: AbortSignal, config: Config): Promise<RemoteFile> {
  signal.throwIfAborted();
  const deadline = Date.now() + config.totalTimeoutMs;
  let current = parseHop(input);
  for (let hop = 0; ; hop++) {
    // An abort between two hops fails at once instead of waiting for the next hop's timeout.
    signal.throwIfAborted();
    const hopDeadline = Math.min(deadline, Date.now() + config.headerTimeoutMs);
    const address = await vetHost(current, config, signal, hopDeadline);
    const outcome = await fetchHop(current, address, config, signal, deadline, hopDeadline);
    if (outcome.kind === 'file') return outcome.file;
    if (hop >= config.maxRedirects || outcome.location === undefined) throw failure('rejected');
    current = parseHop(outcome.location, current);
  }
}

/** The URL rule of one hop: parsable, `http:` or `https:`, no user info. */
function parseHop(text: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw failure('rejected');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('rejected');
  if (url.username !== '' || url.password !== '') throw failure('rejected');
  return url;
}

function bareHost(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** The address the hop connects to: the literal, or the first of the resolved addresses once all of them passed. */
async function vetHost(url: URL, config: Config, signal: AbortSignal, until: number): Promise<string> {
  const host = bareHost(url);
  const addresses = net.isIP(host) !== 0 ? [host] : await bounded(config.lookup(host), signal, until);
  if (addresses.length === 0) throw failure('unreachable');
  if (!addresses.every((address) => typeof address === 'string' && config.allowAddress(address))) {
    throw failure('address_refused');
  }
  return addresses[0]!;
}

/** `promise` bounded by `signal` (rejects with its reason) and `until` (rejects `unreachable`); its failure is `unreachable`. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal, until: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A listener added to an aborted signal never fires.
    if (signal.aborted) {
      promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(() => reject(failure('unreachable'))), Math.max(0, until - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(failure('unreachable'))),
    );
  });
}

type HopOutcome = { kind: 'file'; file: RemoteFile } | { kind: 'redirect'; location: string | undefined };

function fetchHop(
  url: URL,
  address: string,
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
      headers: { 'User-Agent': config.userAgent, Accept: '*/*', 'Accept-Encoding': 'identity' },
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
      if (status !== 200) {
        res.destroy();
        if (REDIRECT_STATUSES.has(status)) {
          settle(() => {
            req.destroy();
            resolve({ kind: 'redirect', location: res.headers.location });
          });
        } else {
          fail(statusFailure(status, res.headers['retry-after']));
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
            stream: bodyStream(req, res, config, signal, deadline, contentLength),
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

/**
 * The body as a stream that counts bytes: past `maxBytes` it fails `too_large`; without data for the idle time
 * while it waits for some, past the total deadline, on a socket error or when shorter than `Content-Length` it
 * fails `unreachable`; an abort fails it with the abort reason. Destroying it destroys the request.
 */
function bodyStream(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  config: Config,
  signal: AbortSignal,
  deadline: number,
  contentLength: number | null,
): Readable {
  let received = 0;
  let done = false;
  let started = false;
  let idle: NodeJS.Timeout | undefined;

  const stopIdle = () => clearTimeout(idle);
  const startIdle = () => {
    stopIdle();
    idle = setTimeout(() => fail(failure('unreachable')), config.idleTimeoutMs);
  };
  const finish = () => {
    done = true;
    stopIdle();
    clearTimeout(total);
    signal.removeEventListener('abort', onAbort);
  };
  /**
   * Ends the stream with `error`. Before the first read the error waits for the next turn of the event loop, so a
   * consumer that attaches its listener right after `open` resolves always receives it.
   */
  const fail = (error: unknown) => {
    if (done) return;
    finish();
    if (started) out.destroy(error as Error);
    else setImmediate(() => out.destroy(error as Error));
  };

  const out = new Readable({
    read() {
      if (done) return;
      if (!started) {
        started = true;
        attach();
      }
      startIdle();
      res.resume();
    },
    destroy(error, callback) {
      if (!done) finish();
      res.destroy();
      req.destroy();
      callback(error);
    },
  });

  const onAbort = () => fail(signal.reason);
  const total = setTimeout(() => fail(failure('unreachable')), Math.max(0, deadline - Date.now()));
  // A listener added to an aborted signal never fires.
  if (signal.aborted) fail(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  // A lost connection before the first read; the body itself is only consumed once the stream is read.
  res.on('error', () => fail(failure('unreachable')));
  res.on('close', () => {
    if (!res.complete) fail(failure('unreachable'));
  });
  req.on('error', () => fail(failure('unreachable')));
  return out;

  function attach(): void {
    res.on('data', (chunk: Buffer) => {
      if (done) return;
      received += chunk.length;
      if (received > config.maxBytes) {
        fail(failure('too_large'));
        return;
      }
      if (out.push(chunk)) {
        startIdle();
      } else {
        stopIdle();
        res.pause();
      }
    });
    res.on('end', () => {
      if (done) return;
      if (contentLength !== null && received < contentLength) {
        fail(failure('unreachable'));
        return;
      }
      finish();
      out.push(null);
    });
  }
}

function statusFailure(status: number, retryAfter: string | undefined): RemoteFileError {
  if (status === 429 || status === 503) return failure('throttled', retryAfterMs(retryAfter));
  if (BLOCKED_STATUSES.has(status)) return failure('blocked');
  if (NOT_FOUND_STATUSES.has(status)) return failure('not_found');
  if (status === 408 || (status >= 500 && status <= 599)) return failure('unavailable');
  return failure('rejected');
}

/** The shape of an IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. */
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** `Retry-After` as integer seconds or an IMF-fixdate, clamped; the default when absent or of any other shape. */
function retryAfterMs(value: string | undefined): number {
  if (value === undefined) return clampRetryAfterMs(null);
  const text = value.trim();
  if (/^\d+$/.test(text)) return clampRetryAfterMs(Number(text) * 1000);
  if (!HTTP_DATE.test(text)) return clampRetryAfterMs(null);
  const at = Date.parse(text);
  return clampRetryAfterMs(Number.isNaN(at) ? null : Math.max(0, at - Date.now()));
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** The lower-cased media type without parameters; null when absent or empty. */
function mediaType(value: string | undefined): string | null {
  const type = value?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === '' ? null : type;
}

/** The file name of a `Content-Disposition`: `filename*` (RFC 5987, UTF-8 or ISO-8859-1) first, then `filename`. */
export function dispositionName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]*)/i.exec(value);
  if (extended) {
    const decoded = decodeExtended(extended[1]!.trim());
    if (decoded !== null && decoded !== '') return decoded;
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
  if (quoted) {
    const name = quoted[1]!.replace(/\\(.)/g, '$1');
    return name === '' ? null : name;
  }
  const token = /(?:^|;)\s*filename\s*=\s*([^;"\s][^;]*)/i.exec(value);
  if (token) {
    const name = token[1]!.trim();
    return name === '' ? null : name;
  }
  return null;
}

function decodeExtended(value: string): string | null {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return null;
  const charset = m[1]!.toLowerCase();
  const encoded = m[2]!;
  try {
    if (charset === 'utf-8') return decodeURIComponent(encoded);
    if (charset === 'iso-8859-1') {
      if (/%(?![0-9a-f]{2})/i.test(encoded)) return null;
      return encoded.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  } catch {
    return null;
  }
  return null;
}
