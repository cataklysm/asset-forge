// The vision provider configuration of phase 4a: two environment variables, read once at start.
// A seam until 4b stores provider settings.

export const DEFAULT_VISION_BASE_URL = 'http://127.0.0.1:11500';
export const DEFAULT_VISION_MODEL = 'mock-vision';

/** An unusable base URL falls back to the default with a warning; the value itself is never logged. */
export function readVisionConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = () => {},
): { baseUrl: string; model: string } {
  const rawUrl = env['ASSETFORGE_VISION_BASE_URL'];
  let baseUrl = DEFAULT_VISION_BASE_URL;
  if (rawUrl !== undefined) {
    const usable = usableBaseUrl(rawUrl);
    if (usable === null) warn('ASSETFORGE_VISION_BASE_URL is not a usable http(s) URL; using the default');
    else baseUrl = usable;
  }
  const rawModel = env['ASSETFORGE_VISION_MODEL']?.trim();
  return { baseUrl, model: rawModel ? rawModel : DEFAULT_VISION_MODEL };
}

/**
 * The base URL rule: http or https, no user info, no query, no fragment (not even a bare `?`/`#`).
 * Returns the URL without trailing slashes, or null when it is not usable.
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
