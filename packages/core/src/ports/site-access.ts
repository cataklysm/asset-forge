import type { RemoteFile, RemoteOpenOptions, RemoteRequestHeaders } from './remote-files.js';

/** The logins of the site profiles, as the download path sees them. Implemented outside core. */
export interface SiteAccess {
  /**
   * The site of a profile.
   *
   * @param profileId the site profile
   * @returns its site; null when the profile does not exist
   */
  siteOf(profileId: string): Promise<string | null>;
  /**
   * The login headers of a profile for one request.
   *
   * @param profileId the site profile
   * @param url the address of the hop
   * @returns the headers; null unless the URL belongs to the profile's site
   */
  headersFor(profileId: string, url: string): Promise<RemoteRequestHeaders | null>;
  /**
   * Opens a site download through the profile's own browser session: every hop on the profile's site goes out with
   * the session's cookies and network stack, the first hop off the site and the rest go through the plain
   * `RemoteFileSource`. Asks `options.headersFor` once per hop like `RemoteFileSource.open`. Absent where no browser
   * session exists.
   *
   * @param profileId the site profile
   * @param url the address to fetch
   * @param signal aborts the request and the body
   * @param options extra headers per hop
   * @returns the opened file; rejects with RemoteFileError, or with the abort reason once `signal` aborts
   */
  open?(profileId: string, url: string, signal: AbortSignal, options: RemoteOpenOptions): Promise<RemoteFile>;
}
