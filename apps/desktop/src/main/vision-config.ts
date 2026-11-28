// The base URL rule of the vision provider, shared by the stored settings and the environment.

/**
 * The base URL rule: http or https, no user info, no query, no fragment (not even a bare `?`/`#`).
 *
 * @param raw the URL as typed or set
 * @returns the URL without trailing slashes, or null when it is not usable
 */
export function usableBaseUrl(raw: string): string | null {
  // A bare `?` or `#` leaves search and hash empty but stays in `href`.
  if (raw.includes('?') || raw.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.href.replace(/\/+$/, '');
}
