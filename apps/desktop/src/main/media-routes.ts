import { z } from 'zod';
import type { PreviewSize } from '@assetforge/media';

// The media scheme and the exact spelling of its three routes: `preview`, `original` and `video`.

/** Internal protocol through which the renderer loads cached previews, unchanged originals and videos. */
export const MEDIA_SCHEME = 'assetforge-media';

/**
 * Registered before the app is ready. `standard` makes media URLs parse like http URLs (host, path,
 * canonical form); `secure` treats the scheme as a secure origin, so loading media into the page is not
 * mixed content; `stream` lets the video element read a response body as it arrives and seek through
 * byte ranges. The renderer's CSP admits the scheme through its explicit `img-src` and `media-src`
 * entries, not through any privilege.
 */
export const MEDIA_SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, stream: true });

const SIZES: readonly PreviewSize[] = ['thumb', 'detail', 'full'];
const FILE_ID = z.uuid();

/**
 * Parses an absolute URL of the media scheme with the given host and checks the parts every route
 * shares: no port, no credentials, no fragment (not even an empty `#`), exactly one path segment
 * holding a file UUID. The caller still compares against its canonical spelling.
 *
 * @param url the URL as the request carries it
 * @param host the route's host
 * @returns the file id and the parsed URL, or null
 */
function parseFileUrl(url: string, host: string): { fileId: string; parsed: URL } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== host) return null;
  if (parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return null;
  const segments = parsed.pathname.split('/');
  if (segments.length !== 2 || segments[0] !== '') return null;
  const fileId = segments[1]!;
  if (!FILE_ID.safeParse(fileId).success) return null;
  return { fileId, parsed };
}

/**
 * Accepts only `assetforge-media://preview/<file uuid>?size=thumb|detail|full`, spelled exactly like
 * that: one path segment, one query parameter, no credentials, no port, no fragment (not even an
 * empty `#`), no dot segments. Anything else is null.
 *
 * The final comparison against the canonical spelling rejects every form the URL parser would
 * otherwise normalise away (dot segments, an empty fragment). The host is compared case-sensitively:
 * Node keeps the case of a non-special scheme's host, so `PREVIEW` is rejected here; under Electron's
 * standard-scheme registration Chromium lowercases the host before the handler sees it, which only
 * ever addresses the same preview. Chromium also never forwards a fragment to a protocol handler.
 *
 * @param url the URL as the request carries it
 * @returns the file id and the size, or null
 */
export function parsePreviewUrl(url: string): { fileId: string; size: PreviewSize } | null {
  const target = parseFileUrl(url, 'preview');
  if (target === null) return null;
  const params = [...target.parsed.searchParams.entries()];
  if (params.length !== 1) return null;
  const [name, value] = params[0]!;
  if (name !== 'size' || !SIZES.includes(value as PreviewSize)) return null;
  if (url !== `${MEDIA_SCHEME}://preview/${target.fileId}?size=${value}`) return null;
  return { fileId: target.fileId, size: value as PreviewSize };
}

/**
 * Accepts only `assetforge-media://original/<file uuid>`, spelled exactly like that: no query (not
 * even an empty `?`), no fragment, no trailing slash, no further segment, no credentials, no port.
 * The same canonical-spelling comparison as in `parsePreviewUrl` applies.
 *
 * @param url the URL as the request carries it
 * @returns the file id, or null
 */
export function parseOriginalUrl(url: string): { fileId: string } | null {
  const target = parseFileUrl(url, 'original');
  if (target === null) return null;
  if (url !== `${MEDIA_SCHEME}://original/${target.fileId}`) return null;
  return { fileId: target.fileId };
}

/**
 * Accepts only `assetforge-media://video/<file uuid>`, under the same rules as `parseOriginalUrl`.
 *
 * @param url the URL as the request carries it
 * @returns the file id, or null
 */
export function parseVideoUrl(url: string): { fileId: string } | null {
  const target = parseFileUrl(url, 'video');
  if (target === null) return null;
  if (url !== `${MEDIA_SCHEME}://video/${target.fileId}`) return null;
  return { fileId: target.fileId };
}
