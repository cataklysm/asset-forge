import type { RemoteFile, RemoteOpenOptions, RemoteRequestHeaders } from './remote-files.js';

/** The logins of the site profiles, as the download path sees them. */
export interface SiteAccess {
  /** The site of the profile; null when the profile does not exist. */
  siteOf(profileId: string): Promise<string | null>;
  /** Null unless the URL belongs to the profile's site. */
  headersFor(profileId: string, url: string): Promise<RemoteRequestHeaders | null>;
  /**
   * Opens a site download through the profile's own browser session: every hop on the profile's site goes out with
   * the session's cookies and network stack, the first hop off the site and the rest go through the plain
   * `RemoteFileSource`. Asks `options.headersFor` once per hop like `RemoteFileSource.open`. Rejects with
   * RemoteFileError, or with the abort reason once `signal` aborts. Absent where no browser session exists.
   */
  open?(profileId: string, url: string, signal: AbortSignal, options: RemoteOpenOptions): Promise<RemoteFile>;
}
