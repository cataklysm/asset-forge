import { sanitizeFileName } from './file-names.js';
import { fileKind, importExtension } from './media-types.js';

/** Extensions appended to a name the application does not know, by the content type of the answer. */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'model/gltf-binary': 'glb',
};
const MAPPED_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(EXTENSION_BY_CONTENT_TYPE));

const FALLBACK_NAME = 'download';

/** Lower case, without parameters. */
function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type === '' ? null : type;
}

/** The last path segment of a URL, percent-decoded (as it is when undecodable); null when there is none. */
function lastSegment(finalUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    return null;
  }
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (segment === '') return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The name a download is stored under: the Content-Disposition name, else the last path segment of the final URL,
 * else `download`; through `sanitizeFileName`. A name of an unknown kind whose extension is none of the mapped ones
 * gets the extension of a known content type.
 */
export function downloadFileName(r: { finalUrl: string; contentType: string | null; dispositionName: string | null }): string {
  const raw = r.dispositionName !== null && r.dispositionName.trim() !== '' ? r.dispositionName : lastSegment(r.finalUrl);
  const name = sanitizeFileName(raw ?? FALLBACK_NAME);
  if (fileKind(name) !== 'other') return name;
  const current = importExtension(name);
  if (current !== null && MAPPED_EXTENSIONS.has(current)) return name;
  const type = mediaType(r.contentType);
  const extension = type !== null && Object.hasOwn(EXTENSION_BY_CONTENT_TYPE, type) ? EXTENSION_BY_CONTENT_TYPE[type]! : null;
  // Sanitised again so a name at the length limit keeps the appended extension.
  return extension === null ? name : sanitizeFileName(`${name}.${extension}`);
}

/** True for an answer that is a web page, not a file. */
export function isWebPage(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === 'text/html' || type === 'application/xhtml+xml';
}
