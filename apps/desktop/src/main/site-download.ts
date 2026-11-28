import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { belongsToSite } from '@assetforge/contracts';
import {
  DOWNLOAD_HEADER_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  DOWNLOAD_TOTAL_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_REDIRECTS,
  RemoteFileError,
  type RemoteFile,
  type RemoteFileSource,
  type RemoteOpenOptions,
} from '@assetforge/core';
import { bounded, isPublicAddress } from '@assetforge/storage';
import type { SessionNetRequest } from './session-request.js';
import { sessionHop } from './session-hop.js';

// Site downloads through the profile's own browser session (spec "Browser check"). A hop on the profile's site goes
// out through Electron's network stack with the session's cookies, so a site that bound its clearance to the browser
// that passed its check accepts the download; the first hop off the site and every hop after it go through the plain
// Node source. Electron is not imported here: the request is made by `SiteSessions.request`, which tests fake.
// Nothing here logs, and no error carries a URL, an address, a header or a cause.


/** The limits of a session download; the same as those of the Node source. */
export interface SessionDownloadLimits {
  maxBytes: number;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
}

export const SESSION_DOWNLOAD_LIMITS: SessionDownloadLimits = {
  maxBytes: MAX_DOWNLOAD_BYTES,
  headerTimeoutMs: DOWNLOAD_HEADER_TIMEOUT_MS,
  idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
  totalTimeoutMs: DOWNLOAD_TOTAL_TIMEOUT_MS,
  maxRedirects: MAX_DOWNLOAD_REDIRECTS,
};

export interface SessionDownloadDeps {
  /** The site of the profile, null when the profile does not exist. */
  siteOf(profileId: string): string | null;
  /** Starts one GET through the profile's session without following redirects; may throw. */
  request(profileId: string, url: string): SessionNetRequest;
  /** The plain source that takes over at the first hop off the site. */
  remote: RemoteFileSource;
  /** Resolves a host to its addresses; defaults to the system resolver (all addresses). */
  lookup?: (host: string) => Promise<string[]>;
  limits?: Partial<SessionDownloadLimits>;
}

/** What `SiteAccess.open` is. */
export type SessionDownload = (profileId: string, url: string, signal: AbortSignal, options: RemoteOpenOptions) => Promise<RemoteFile>;

export interface Config {
  siteOf: SessionDownloadDeps['siteOf'];
  request: SessionDownloadDeps['request'];
  remote: RemoteFileSource;
  lookup: (host: string) => Promise<string[]>;
  limits: SessionDownloadLimits;
}

/**
 * The resolver used when none is injected.
 *
 * @param host the host name to resolve
 * @returns every address the system resolver answers
 */
async function systemLookup(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * Creates the session download of the site profiles.
 *
 * @param deps the profile lookup, the session request, the plain source and optional resolver and limits
 * @returns the function `SiteAccess.open` delegates to
 */
export function createSessionDownload(deps: SessionDownloadDeps): SessionDownload {
  const config: Config = {
    siteOf: deps.siteOf,
    request: deps.request,
    remote: deps.remote,
    lookup: deps.lookup ?? systemLookup,
    limits: { ...SESSION_DOWNLOAD_LIMITS, ...deps.limits },
  };
  return (profileId, url, signal, options) => openThroughSession(config, profileId, url, signal, options);
}

/** A failure without a cause: a cause could carry the URL or an address. */
export const failure = (kind: 'rejected' | 'unreachable' | 'address_refused' | 'too_large'): RemoteFileError => new RemoteFileError(kind);

/**
 * The hop loop: every hop on the site is vetted and sent through the session; the first hop off the site is handed
 * to the plain source with the same options, which then follows the rest by its own rules.
 *
 * @param config the wired dependencies and limits
 * @param profileId the profile whose session carries the on-site hops
 * @param input the URL of the download
 * @param signal aborts the download with its reason
 * @param options asked for each hop's headers; on the site only to record the hop, the session sends its own cookies
 * @returns the opened file
 */
async function openThroughSession(
  config: Config,
  profileId: string,
  input: string,
  signal: AbortSignal,
  options: RemoteOpenOptions,
): Promise<RemoteFile> {
  signal.throwIfAborted();
  const site = config.siteOf(profileId);
  if (site === null) throw failure('rejected');
  const { limits } = config;
  const deadline = Date.now() + limits.totalTimeoutMs;
  let current = parseHop(input);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    if (!belongsToSite(current.href, site)) return config.remote.open(current.href, signal, options);
    const hopDeadline = Math.min(deadline, Date.now() + limits.headerTimeoutMs);
    await vetHost(current, config, signal, hopDeadline);
    await askHeaders(current, options, signal, hopDeadline);
    const outcome = await sessionHop(current, profileId, config, signal, deadline, hopDeadline);
    if (outcome.kind === 'file') return outcome.file;
    if (hop >= limits.maxRedirects || outcome.location === undefined) throw failure('rejected');
    current = parseHop(outcome.location, current);
  }
}

/**
 * The URL rule of one hop: parsable, `http:` or `https:`, no user info.
 *
 * @param text the URL or redirect target
 * @param base the URL a relative target is resolved against
 * @returns the parsed URL; throws `rejected` otherwise
 */
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

/**
 * Vets the host of a session hop the way the Node source does: an IP literal or every resolved address must pass
 * `isPublicAddress`. The session request itself is not pinned to the vetted address; the session's request filter
 * vets it a second time.
 *
 * @param url the hop
 * @param config supplies the resolver
 * @param signal aborts the lookup with its reason
 * @param until the hop's deadline
 * @returns nothing; throws `address_refused`, or `unreachable` when the host does not resolve
 */
async function vetHost(url: URL, config: Config, signal: AbortSignal, until: number): Promise<void> {
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const addresses = isIP(host) !== 0 ? [host] : await bounded(Promise.resolve().then(() => config.lookup(host)), signal, until);
  if (addresses.length === 0) throw failure('unreachable');
  if (!addresses.every((address) => typeof address === 'string' && isPublicAddress(address))) throw failure('address_refused');
}

/**
 * Asks `headersFor` for an on-site hop so the caller records it. The answer is dropped: the session sends its own
 * cookies and its own user agent, and nothing is set by hand.
 *
 * @param url the hop
 * @param options carries the callback
 * @param signal aborts the wait with its reason
 * @param until the hop's deadline
 * @returns nothing; a rejecting callback fails the hop `unreachable`
 */
async function askHeaders(url: URL, options: RemoteOpenOptions, signal: AbortSignal, until: number): Promise<void> {
  const headersFor = options.headersFor;
  if (headersFor === undefined) return;
  await bounded(
    Promise.resolve().then(() => headersFor(url.href)),
    signal,
    until,
  );
}

