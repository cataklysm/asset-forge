/**
 * One header value as text: the first of several, undefined when absent.
 *
 * @param value a header value as Node or Electron hands it
 * @returns the value, or the first one of a list
 */
export function headerText(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * An announced `Content-Length`.
 *
 * @param value the header's value
 * @returns the length, or null when absent or not a plain number
 */
export function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * The lower-cased media type without parameters.
 *
 * @param value the `Content-Type` header
 * @returns the media type, or null when absent or empty
 */
export function mediaType(value: string | undefined): string | null {
  const type = value?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === '' ? null : type;
}

/** The file name of a `Content-Disposition`: `filename*` (RFC 5987, UTF-8 or ISO-8859-1) first, then `filename`. */
export function dispositionName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]*)/i.exec(value);
  if (extended) {
    const decoded = decodeExtended(extended[1]!.trim());
    if (decoded !== null && decoded !== '') return decoded;
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
  if (quoted) {
    const name = quoted[1]!.replace(/\\(.)/g, '$1');
    return name === '' ? null : name;
  }
  const token = /(?:^|;)\s*filename\s*=\s*([^;"\s][^;]*)/i.exec(value);
  if (token) {
    const name = token[1]!.trim();
    return name === '' ? null : name;
  }
  return null;
}

function decodeExtended(value: string): string | null {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return null;
  const charset = m[1]!.toLowerCase();
  const encoded = m[2]!;
  try {
    if (charset === 'utf-8') return decodeURIComponent(encoded);
    if (charset === 'iso-8859-1') {
      if (/%(?![0-9a-f]{2})/i.test(encoded)) return null;
      return encoded.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  } catch {
    return null;
  }
  return null;
}
