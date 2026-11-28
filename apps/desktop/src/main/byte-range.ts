// The `Range` header of a video request: read before the size is known, resolved against it afterwards.

/** An inclusive byte range resolved against the file size. */
export interface ByteRange {
  /** The first byte served. */
  start: number;
  /** The last byte served, inclusive. */
  end: number;
}

/**
 * A `Range` header as asked, before the size is known: `bytes=a-b` / `bytes=a-` (`end` null), `bytes=-n`
 * (`suffix`), or `invalid` for anything malformed. Resolved by `resolveRange` against the size.
 */
export type RangeRequest = { start: number; end: number | null } | { suffix: number } | 'invalid';

const DIGITS = /^\d+$/;

/**
 * Reads one offset of a range.
 *
 * @param text the characters between `=`, `-` and the end
 * @returns a non-negative safe integer from a run of decimal digits, or null
 */
function byteOffset(text: string): number | null {
  if (!DIGITS.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads a `Range` header. null when there is none or it asks for several ranges (both are served as the
 * whole file); `invalid` for a malformed one. The unit is compared regardless of case; no whitespace is
 * accepted inside the range.
 *
 * @param header the header's value, null without one
 * @returns the range asked for, `invalid`, or null
 */
export function parseRangeHeader(header: string | null): RangeRequest | null {
  if (header === null) return null;
  const separator = header.indexOf('=');
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== 'bytes') return 'invalid';
  const spec = header.slice(separator + 1);
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return 'invalid';
  const first = spec.slice(0, dash);
  const last = spec.slice(dash + 1);
  if (first === '') {
    const suffix = byteOffset(last);
    return suffix === null ? 'invalid' : { suffix };
  }
  const start = byteOffset(first);
  if (start === null) return 'invalid';
  if (last === '') return { start, end: null };
  const end = byteOffset(last);
  return end === null || end < start ? 'invalid' : { start, end };
}

/**
 * The inclusive range to serve from a file of `size` bytes.
 *
 * @param request the range asked for
 * @param size the file's size
 * @returns the range, or null when it cannot be satisfied
 */
export function resolveRange(request: RangeRequest, size: number): ByteRange | null {
  if (request === 'invalid' || size === 0) return null;
  if ('suffix' in request) {
    if (request.suffix === 0) return null;
    return { start: Math.max(0, size - request.suffix), end: size - 1 };
  }
  if (request.start >= size) return null;
  return { start: request.start, end: Math.min(request.end ?? size - 1, size - 1) };
}
