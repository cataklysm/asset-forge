import { belongsToSite } from '@assetforge/contracts';
import type { RemoteFileSource, RemoteRequestHeaders, SiteAccess } from '@assetforge/core';
import type { SiteProfileStore } from './site-profile-store.js';
import { createSessionDownload, type SessionDownloadLimits } from './site-download.js';
import type { HostResolver } from './site-request-filter.js';
import type { SiteSessions } from './site-sessions.js';

/** A cookie value Node would refuse in a header, or one that would split it. */
const UNSAFE_COOKIE = /[\u0000-\u001f\u007f;]/;

/** The `Cookie` header of the cookies a session would send: `name=value` joined by `; `; null without any. */
export function cookieHeader(cookies: readonly { name: string; value: string }[]): string | null {
  const parts = cookies
    .filter((c) => !UNSAFE_COOKIE.test(c.name) && !UNSAFE_COOKIE.test(c.value) && !c.name.includes('='))
    .map((c) => `${c.name}=${c.value}`);
  return parts.length === 0 ? null : parts.join('; ');
}

/** What the session download of `createSiteAccess` needs besides the sessions. */
export interface SiteDownloadOptions {
  /** The plain source that takes over at the first hop off the site. */
  remote: RemoteFileSource;
  lookup?: HostResolver;
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
export function createSiteAccess(
  store: Pick<SiteProfileStore, 'get'>,
  sessions: Pick<SiteSessions, 'cookies' | 'userAgent' | 'request'>,
  download?: SiteDownloadOptions,
): SiteAccess {
  const request = sessions.request?.bind(sessions);
  const open =
    request === undefined || download === undefined
      ? undefined
      : createSessionDownload({
          siteOf: (profileId) => store.get(profileId)?.site ?? null,
          request,
          remote: download.remote,
          ...(download.lookup === undefined ? {} : { lookup: download.lookup }),
          ...(download.limits === undefined ? {} : { limits: download.limits }),
        });
  return {
    ...(open === undefined ? {} : { open }),
    siteOf: async (profileId) => store.get(profileId)?.site ?? null,
    async headersFor(profileId, url): Promise<RemoteRequestHeaders | null> {
      const profile = store.get(profileId);
      if (profile === null || !belongsToSite(url, profile.site)) return null;
      const cookie = cookieHeader(await sessions.cookies(profileId, url));
      const userAgent = sessions.userAgent(profileId);
      return cookie === null ? { userAgent } : { cookie, userAgent };
    },
  };
}
