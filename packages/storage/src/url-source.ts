import dns from 'node:dns';
import net from 'node:net';
import {
  DOWNLOAD_HEADER_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  DOWNLOAD_TOTAL_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_REDIRECTS,
  type RemoteFile,
  type RemoteFileSource,
  type RemoteOpenOptions,
} from '@assetforge/core';
import { bounded } from './bounded.js';
import { bareHost, fetchHop, type HopHeaders } from './hop-request.js';
import { isPublicAddress } from './public-address.js';
import { failure } from './remote-failure.js';

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

export interface Config {
  userAgent: string;
  allowAddress: (address: string) => boolean;
  lookup: (host: string) => Promise<string[]>;
  maxBytes: number;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
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
  return { open: (url, signal, openOptions) => openUrl(url, signal, config, openOptions?.headersFor) };
}


/** Anything Node cannot send in a header value, control characters (tab included) among them. */
const UNSENDABLE = /[^\x20-\x7e\x80-\xff]/;

/** A non-empty string without control characters; anything else is dropped, never sent. */
function sendable(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && !UNSENDABLE.test(value) ? value : null;
}

/**
 * The headers of a hop: the callback's answer for exactly this hop's URL, so a hop off the site carries no cookie.
 * Only `Cookie` and a replaced `User-Agent` can come from it. A rejecting callback fails the hop `unreachable`.
 */
async function hopHeaders(
  url: URL,
  headersFor: RemoteOpenOptions['headersFor'],
  config: Config,
  signal: AbortSignal,
  until: number,
): Promise<HopHeaders> {
  if (headersFor === undefined) return { userAgent: config.userAgent, cookie: null };
  // `bounded` turns a rejection into `unreachable` without a cause and an abort into the abort reason.
  const answer = await bounded(
    Promise.resolve().then(() => headersFor(url.href)),
    signal,
    until,
  );
  return {
    userAgent: sendable(answer?.userAgent) ?? config.userAgent,
    cookie: sendable(answer?.cookie),
  };
}

async function openUrl(
  input: string,
  signal: AbortSignal,
  config: Config,
  headersFor: RemoteOpenOptions['headersFor'],
): Promise<RemoteFile> {
  signal.throwIfAborted();
  const deadline = Date.now() + config.totalTimeoutMs;
  let current = parseHop(input);
  for (let hop = 0; ; hop++) {
    // An abort between two hops fails at once instead of waiting for the next hop's timeout.
    signal.throwIfAborted();
    const hopDeadline = Math.min(deadline, Date.now() + config.headerTimeoutMs);
    const address = await vetHost(current, config, signal, hopDeadline);
    const headers = await hopHeaders(current, headersFor, config, signal, hopDeadline);
    const outcome = await fetchHop(current, address, headers, config, signal, deadline, hopDeadline);
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
