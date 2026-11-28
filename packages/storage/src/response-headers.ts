/** `filename*=...` of a `Content-Disposition` (RFC 5987). */
const EXTENDED_NAME = /(?:^|;)\s*filename\*\s*=\s*([^;]*)/i;

/** `filename="..."` of a `Content-Disposition`, backslash escapes inside. */
const QUOTED_NAME = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i;

/** `filename=...` of a `Content-Disposition` without quotes. */
const TOKEN_NAME = /(?:^|;)\s*filename\s*=\s*([^;"\s][^;]*)/i;

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

/**
 * The file name of a `Content-Disposition`: `filename*` (RFC 5987, UTF-8 or ISO-8859-1) first, then `filename`.
 *
 * @param value the `Content-Disposition` header; undefined when absent
 * @returns the file name, or null when the header names none
 */
export function dispositionName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const extended = extendedName(value);
  if (extended !== null) return extended;
  const quoted = QUOTED_NAME.exec(value);
  if (quoted) return nonEmpty(quoted[1]!.replace(/\\(.)/g, '$1'));
  const token = TOKEN_NAME.exec(value);
  if (token) return nonEmpty(token[1]!.trim());
  return null;
}

/**
 * The `filename*` of a `Content-Disposition`, decoded.
 *
 * @param value the `Content-Disposition` header
 * @returns the decoded name; null when there is none, it cannot be decoded or it is empty
 */
function extendedName(value: string): string | null {
  const extended = EXTENDED_NAME.exec(value);
  if (!extended) return null;
  const decoded = decodeExtended(extended[1]!.trim());
  return decoded === '' ? null : decoded;
}

/**
 * A name, or null for an empty one.
 *
 * @param name the name read from the header
 * @returns the name; null when it is empty
 */
function nonEmpty(name: string): string | null {
  return name === '' ? null : name;
}

/**
 * Decodes an RFC 5987 value `charset'language'percent-encoded`.
 *
 * @param value the value of `filename*`
 * @returns the decoded text; null for another charset or a broken encoding
 */
function decodeExtended(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) return null;
  const charset = match[1]!.toLowerCase();
  const encoded = match[2]!;
  try {
    if (charset === 'utf-8') return decodeURIComponent(encoded);
    if (charset === 'iso-8859-1') return decodeLatin1(encoded);
  } catch {
    return null;
  }
  return null;
}

/**
 * Decodes percent-encoded ISO-8859-1.
 *
 * @param encoded the percent-encoded text
 * @returns the decoded text; null when a `%` is not followed by two hex digits
 */
function decodeLatin1(encoded: string): string | null {
  if (/%(?![0-9a-f]{2})/i.test(encoded)) return null;
  return encoded.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
