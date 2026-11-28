import dns from 'node:dns';
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
import { fetchHop, type HopHeaders } from './hop-request.js';
import { askHopHeaders, parseHop, vetHopHost } from './hop-rules.js';
import { isPublicAddress } from './public-address.js';
import { failure } from './remote-failure.js';

/** What `createUrlSource` is configured with; everything but the user agent has a default. */
export interface UrlSourceOptions {
  /** Sent as `User-Agent`, e.g. `AssetForge/<version>`. */
  userAgent: string;
  /** The address policy; defaults to `isPublicAddress`. Only tests pass another one. */
  allowAddress?: (address: string) => boolean;
  /** Resolves a host name to its addresses; defaults to the system resolver (all addresses). */
  lookup?: (host: string) => Promise<string[]>;
  /** The most bytes a body may have; defaults to `MAX_DOWNLOAD_BYTES`. */
  maxBytes?: number;
  /** How long a hop may wait for the headers of its answer; defaults to `DOWNLOAD_HEADER_TIMEOUT_MS`. */
  headerTimeoutMs?: number;
  /** How long a body may go without data; defaults to `DOWNLOAD_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /** How long the whole download may take; defaults to `DOWNLOAD_TOTAL_TIMEOUT_MS`. */
  totalTimeoutMs?: number;
  /** The most redirects followed; defaults to `MAX_DOWNLOAD_REDIRECTS`. */
  maxRedirects?: number;
}

/** The options with every default applied. */
type UrlSourceConfig = Required<UrlSourceOptions>;

/** Anything Node cannot send in a header value, control characters (tab included) among them. */
const UNSENDABLE = /[^\x20-\x7e\x80-\xff]/;

/**
 * The network side of the URL import over Node's `http`/`https`. Every hop passes the scheme and user-info rule and
 * the address check (every resolved address must pass `allowAddress`); the socket connects to exactly the checked
 * address while `Host`, SNI and the certificate check use the host name. Redirects are followed by hand. Nothing is
 * logged.
 *
 * @param options the user agent and optional address policy, resolver and limits
 * @returns the remote file source of the download handler
 */
export function createUrlSource(options: UrlSourceOptions): RemoteFileSource {
  const config: UrlSourceConfig = {
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

/**
 * The resolver used when none is injected.
 *
 * @param host the host name to resolve
 * @returns every address the system resolver answers
 */
async function systemLookup(host: string): Promise<string[]> {
  return (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address);
}

/**
 * The hop loop: every hop is parsed, vetted, given its headers and sent; a redirect becomes the next hop until the
 * file arrives or the redirect limit is reached.
 *
 * @param input the URL of the download
 * @param signal aborts the download with its reason
 * @param config the options with their defaults
 * @param headersFor asked for the headers of each hop; undefined sends only the configured user agent
 * @returns the opened file; rejects with a `RemoteFileError` or the abort reason
 */
async function openUrl(
  input: string,
  signal: AbortSignal,
  config: UrlSourceConfig,
  headersFor: RemoteOpenOptions['headersFor'],
): Promise<RemoteFile> {
  signal.throwIfAborted();
  const deadline = Date.now() + config.totalTimeoutMs;
  let current = parseHop(input);
  for (let hop = 0; ; hop++) {
    // An abort between two hops fails at once instead of waiting for the next hop's timeout.
    signal.throwIfAborted();
    const hopDeadline = Math.min(deadline, Date.now() + config.headerTimeoutMs);
    const address = await vetHopHost(current, config, signal, hopDeadline);
    const headers = await hopHeaders(current, headersFor, config, signal, hopDeadline);
    const outcome = await fetchHop(
      { url: current, address, headers },
      { limits: config, signal, deadline, hopDeadline },
    );
    if (outcome.kind === 'file') return outcome.file;
    if (hop >= config.maxRedirects || outcome.location === undefined) throw failure('rejected');
    current = parseHop(outcome.location, current);
  }
}

/**
 * The headers of a hop: the callback's answer for exactly this hop's URL, so a hop off the site carries no cookie.
 * Only `Cookie` and a replaced `User-Agent` can come from it.
 *
 * @param url the hop
 * @param headersFor the caller's callback; undefined sends the configured user agent and no cookie
 * @param config supplies the configured user agent
 * @param signal aborts the wait with its reason
 * @param until the hop's deadline
 * @returns the headers of the hop; a rejecting callback fails the hop `unreachable`
 */
async function hopHeaders(
  url: URL,
  headersFor: RemoteOpenOptions['headersFor'],
  config: UrlSourceConfig,
  signal: AbortSignal,
  until: number,
): Promise<HopHeaders> {
  if (headersFor === undefined) return { userAgent: config.userAgent, cookie: null };
  const answer = await askHopHeaders(url, headersFor, signal, until);
  return {
    userAgent: sendable(answer?.userAgent) ?? config.userAgent,
    cookie: sendable(answer?.cookie),
  };
}

/**
 * A header value as the callback answered it, if it can be sent.
 *
 * @param value the value of the answer
 * @returns a non-empty string without control characters; null for anything else, which is dropped, never sent
 */
function sendable(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && !UNSENDABLE.test(value) ? value : null;
}
