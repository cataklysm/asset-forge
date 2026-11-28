/**
 * The lower-case host of an http(s) URL without user info.
 *
 * @param url the URL as text
 * @returns the host, or null for anything else or a host ending in a dot
 */
function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === '' || host.endsWith('.')) return null;
  return host;
}

/**
 * The site of a URL: its lower-case host without a leading `www.`. Null for a non-http(s) URL, user info, an empty
 * host or a host ending in a dot, and for a single label without a dot (`localhost`, `intranet`) unless it is an
 * IPv6 literal, since such a site would let every host under it belong to it. An IPv4 literal always has dots. It
 * does not apply the full URL rule of the import; the caller does.
 *
 * @param url the URL as text
 * @returns the site, or null when the URL gives none
 */
export function siteOf(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return null;
  const site = host.startsWith('www.') ? host.slice(4) : host;
  if (site === '') return null;
  if (!site.includes('.') && !site.startsWith('[')) return null;
  return site;
}

/**
 * Whether a URL belongs to a site: http(s) without user info, and its host is `site` or ends with `.` + `site`.
 *
 * @param url the URL as text
 * @param site the site of a profile, compared regardless of case
 * @returns true when the URL belongs to the site; false for an empty site
 */
export function belongsToSite(url: string, site: string): boolean {
  const wanted = site.toLowerCase();
  if (wanted === '') return false;
  const host = hostOf(url);
  if (host === null) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}
