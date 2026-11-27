const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBytes(n: number | null): string {
  if (n === null) return '–';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const SHORT_URL_MAX = 60;

/**
 * A web address for display only: the host and the last path segment ('example.com/rock.png'),
 * at most 60 characters; an address that does not parse is cut to 60 characters as it is.
 */
export function shortUrl(text: string): string {
  let short = text;
  try {
    const url = new URL(text);
    const last = url.pathname.split('/').filter((part) => part !== '').pop();
    let segment = last ?? '';
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // A malformed escape stays as it is.
    }
    short = segment === '' ? url.host : `${url.host}/${segment}`;
  } catch {
    // Not an address: shown cut as it is.
  }
  return short.slice(0, SHORT_URL_MAX);
}
