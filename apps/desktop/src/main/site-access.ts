import { belongsToSite } from '@assetforge/contracts';
import type { RemoteFileSource, RemoteRequestHeaders, SiteAccess } from '@assetforge/core';
import type { SiteProfileStore } from './site-profile-store.js';
import { createSessionDownload, type SessionDownload, type SessionDownloadLimits } from './site-download.js';
import type { HostResolver } from './site-request-filter.js';
import type { SiteSessions } from './site-sessions.js';

// The logins of the site profiles as the download handler sees them: cookies and the session user agent go only to
// a URL of the profile's own site. Nothing here logs a URL or a cookie.

/** The profile lookup the site access reads. */
type ProfileLookup = Pick<SiteProfileStore, 'get'>;

/** The parts of the sessions the site access uses. */
type AccessSessions = Pick<SiteSessions, 'cookies' | 'userAgent' | 'request'>;

/** A cookie value Node would refuse in a header, or one that would split it. */
const UNSAFE_COOKIE = /[\u0000-\u001f\u007f;]/;

/**
 * The `Cookie` header of the cookies a session would send; a cookie that cannot be sent safely is left out.
 *
 * @param cookies the session's cookies for the URL
 * @returns `name=value` joined by `; `; null without any
 */
export function cookieHeader(cookies: readonly { name: string; value: string }[]): string | null {
  const parts = cookies
    .filter((cookie) => !UNSAFE_COOKIE.test(cookie.name) && !UNSAFE_COOKIE.test(cookie.value) && !cookie.name.includes('='))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return parts.length === 0 ? null : parts.join('; ');
}

/** What the session download of `createSiteAccess` needs besides the sessions. */
export interface SiteDownloadOptions {
  /** The plain source that takes over at the first hop off the site. */
  remote: RemoteFileSource;
  /** Resolves a host to its addresses; defaults to the system resolver. */
  lookup?: HostResolver;
  /** Replaces single limits of the session download. */
  limits?: Partial<SessionDownloadLimits>;
}

/**
 * The logins of the profiles for the download path (spec "Download" and "Browser check").
 *
 * @param store reads the profiles
 * @param sessions the profiles' sessions; with `request` the downloads of a profile go through its session
 * @param download the plain source and the limits of a session download; without it `open` is absent
 * @returns the site access of the download handler
 */
export function createSiteAccess(store: ProfileLookup, sessions: AccessSessions, download?: SiteDownloadOptions): SiteAccess {
  const open = sessionDownloadOf(store, sessions, download);
  return {
    ...(open === undefined ? {} : { open }),
    siteOf: (profileId) => profileSite(store, profileId),
    headersFor: (profileId, url) => profileHeaders(store, sessions, profileId, url),
  };
}

/**
 * The session download of the profiles, when the sessions can make requests and a plain source was given.
 *
 * @param store reads the profiles
 * @param sessions the profiles' sessions
 * @param download the plain source, resolver and limits
 * @returns the function `SiteAccess.open` is; undefined without a session request or without `download`
 */
function sessionDownloadOf(
  store: ProfileLookup,
  sessions: AccessSessions,
  download: SiteDownloadOptions | undefined,
): SessionDownload | undefined {
  const request = sessions.request?.bind(sessions);
  if (request === undefined || download === undefined) return undefined;
  return createSessionDownload({
    siteOf: (profileId) => store.get(profileId)?.site ?? null,
    request,
    remote: download.remote,
    ...(download.lookup === undefined ? {} : { lookup: download.lookup }),
    ...(download.limits === undefined ? {} : { limits: download.limits }),
  });
}

/**
 * The site of a profile.
 *
 * @param store reads the profiles
 * @param profileId the profile
 * @returns the site; null when the profile does not exist
 */
async function profileSite(store: ProfileLookup, profileId: string): Promise<string | null> {
  return store.get(profileId)?.site ?? null;
}

/**
 * The headers of one hop of a profile's download: its session's cookies and user agent, only for its own site.
 *
 * @param store reads the profiles
 * @param sessions the profiles' sessions
 * @param profileId the profile
 * @param url the hop
 * @returns the user agent and, when there are any, the cookies; null for an unknown profile or a URL off its site
 */
async function profileHeaders(
  store: ProfileLookup,
  sessions: AccessSessions,
  profileId: string,
  url: string,
): Promise<RemoteRequestHeaders | null> {
  const profile = store.get(profileId);
  if (profile === null || !belongsToSite(url, profile.site)) return null;
  const cookie = cookieHeader(await sessions.cookies(profileId, url));
  const userAgent = sessions.userAgent(profileId);
  return cookie === null ? { userAgent } : { cookie, userAgent };
}
