import { lookup } from 'node:dns/promises';
import { belongsToSite } from '@assetforge/contracts';
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
import { askHopHeaders, isPublicAddress, parseHop, vetHopHost } from '@assetforge/storage';
import { failure } from './session-failure.js';
import { sessionHop } from './session-hop.js';
import type { SessionNetRequest } from './session-request.js';

// Site downloads through the profile's own browser session (spec "Browser check"). A hop on the profile's site goes
// out through Electron's network stack with the session's cookies, so a site that bound its clearance to the browser
// that passed its check accepts the download; the first hop off the site and every hop after it go through the plain
// Node source. Electron is not imported here: the request is made by `SiteSessions.request`, which tests fake.
// Nothing here logs, and no error carries a URL, an address, a header or a cause.

/** The limits of a session download; the same as those of the Node source. */
export interface SessionDownloadLimits {
  /** The most bytes a body may have. */
  maxBytes: number;
  /** How long a hop may wait for the headers of its answer. */
  headerTimeoutMs: number;
  /** How long a body may go without data. */
  idleTimeoutMs: number;
  /** How long the whole download may take. */
  totalTimeoutMs: number;
  /** The most redirects followed. */
  maxRedirects: number;
}

/** The default limits of a session download: the download constants of the URL import. */
export const SESSION_DOWNLOAD_LIMITS: SessionDownloadLimits = {
  maxBytes: MAX_DOWNLOAD_BYTES,
  headerTimeoutMs: DOWNLOAD_HEADER_TIMEOUT_MS,
  idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
  totalTimeoutMs: DOWNLOAD_TOTAL_TIMEOUT_MS,
  maxRedirects: MAX_DOWNLOAD_REDIRECTS,
};

/** What `createSessionDownload` is wired with; resolver and limits have defaults. */
export interface SessionDownloadDependencies {
  /** The site of the profile, null when the profile does not exist. */
  siteOf(profileId: string): string | null;
  /** Starts one GET through the profile's session without following redirects; may throw. */
  request(profileId: string, url: string): SessionNetRequest;
  /** The plain source that takes over at the first hop off the site. */
  remote: RemoteFileSource;
  /** Resolves a host to its addresses; defaults to the system resolver (all addresses). */
  lookup?: (host: string) => Promise<string[]>;
  /** Replaces single limits of `SESSION_DOWNLOAD_LIMITS`. */
  limits?: Partial<SessionDownloadLimits>;
}

/** What `SiteAccess.open` is. */
export type SessionDownload = (
  profileId: string,
  url: string,
  signal: AbortSignal,
  options: RemoteOpenOptions,
) => Promise<RemoteFile>;

/** The dependencies with every default applied. */
interface SessionDownloadConfig {
  siteOf: SessionDownloadDependencies['siteOf'];
  request: SessionDownloadDependencies['request'];
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
 * @param dependencies the profile lookup, the session request, the plain source and optional resolver and limits
 * @returns the function `SiteAccess.open` delegates to
 */
export function createSessionDownload(dependencies: SessionDownloadDependencies): SessionDownload {
  const config: SessionDownloadConfig = {
    siteOf: dependencies.siteOf,
    request: dependencies.request,
    remote: dependencies.remote,
    lookup: dependencies.lookup ?? systemLookup,
    limits: { ...SESSION_DOWNLOAD_LIMITS, ...dependencies.limits },
  };
  return (profileId, url, signal, options) => openThroughSession(config, profileId, url, signal, options);
}

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
  config: SessionDownloadConfig,
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
    // The rule of the Node source: an IP literal or every resolved address must pass `isPublicAddress`. The session
    // request itself is not pinned to the vetted address; the session's request filter vets it a second time.
    await vetHopHost(current, { lookup: config.lookup, allowAddress: isPublicAddress }, signal, hopDeadline);
    // Asked only so the caller records the hop; the answer is dropped because the session sends its own cookies and
    // its own user agent, and nothing is set by hand.
    await askHopHeaders(current, options.headersFor, signal, hopDeadline);
    const outcome = await sessionHop(
      { url: current, profileId, request: config.request },
      { limits, signal, deadline, hopDeadline },
    );
    if (outcome.kind === 'file') return outcome.file;
    if (hop >= limits.maxRedirects || outcome.location === undefined) throw failure('rejected');
    current = parseHop(outcome.location, current);
  }
}
