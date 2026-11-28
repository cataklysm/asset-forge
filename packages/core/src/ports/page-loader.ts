/** How the loading of one page of a site crawl ended. */
export type PageLoadResult =
  /**
   * Absolute or relative strings as found, per query name. `baseUrl` is the document's base URL as the page
   * reported it (after redirects and any `<base href>`); the crawl resolves against it only when it is a URL of the
   * profile's site, so any string may come here.
   */
  | { ok: true; results: Record<string, string[]>; baseUrl: string }
  /**
   * `no_match`: the document finished loading but the waited-for query matched nothing in time; `timeout`: it did
   * not finish loading in time; `failed`: a network or other failure, also a cancel.
   */
  | { ok: false; reason: 'no_match' | 'timeout' | 'failed' }
  /** A navigation off the site was refused; `host` is its lower-case host, empty when unknown. */
  | { ok: false; reason: 'left_site'; host: string }
  /** The main frame answered `status` (400 or more) and the waited-for query did not match. */
  | { ok: false; reason: 'http_error'; status: number }
  /** The XPath of the query named `query` could not be evaluated. */
  | { ok: false; reason: 'invalid_xpath'; query: string };

/** Reads pages of a site in a browser session of its profile. Implemented outside core. */
export interface PageLoader {
  /**
   * Loads `url`, waits until the query named `waitFor` matches, then answers every query.
   *
   * @param url the page
   * @param options `queries` the XPath expressions by name, `waitFor` the name of the one to wait for, `signal`
   *   cancels the load
   * @returns the strings found per query, or why the page gave none
   */
  load(
    url: string,
    options: { queries: Record<string, string>; waitFor: string; signal: AbortSignal },
  ): Promise<PageLoadResult>;
}
