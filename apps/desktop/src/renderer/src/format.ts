/** The binary size units, smallest first. */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * A file size for display: '512 B', '1.5 MiB'.
 *
 * @param bytes the size, or null when unknown
 * @returns the size in the largest unit below 1024, '–' for null
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * A stored time for display, in the locale of the system.
 *
 * @param iso an ISO time
 * @returns the local date and time, or the text itself when it does not parse
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** The most code points `shortUrl` shows. */
const SHORT_URL_MAX = 60;
/** Control and format characters (bidi overrides, zero-width marks) that would disguise the shown text. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * The segment decoded for reading; kept encoded when it does not decode or would hide characters.
 *
 * @param segment one encoded path segment
 * @returns the readable segment
 */
function readableSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    return HIDDEN_CHARACTERS.test(decoded) ? segment : decoded;
  } catch {
    return segment;
  }
}

/**
 * A web address for display only: the host and the last path segment ('example.com/rock.png'),
 * at most 60 characters (code points, so a surrogate pair is never split); an address that does
 * not parse is cut to 60 characters as it is.
 *
 * @param text the address as stored
 * @returns the short form
 */
export function shortUrl(text: string): string {
  let short = text;
  try {
    const url = new URL(text);
    const segment = readableSegment(url.pathname.split('/').filter((part) => part !== '').pop() ?? '');
    short = segment === '' ? url.host : `${url.host}/${segment}`;
  } catch {
    // Not an address: shown cut as it is.
  }
  return Array.from(short).slice(0, SHORT_URL_MAX).join('');
}

/**
 * A video length: 'm:ss', from one hour 'h:mm:ss'; whole seconds, rounded down.
 *
 * @param ms the length in milliseconds; a negative value counts as 0
 * @returns the length text
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
