import type { ImageSize } from './messages.js';

/** The `bytes[index]` value as a number; the caller has checked that the index is in range. */
type ByteAt = (index: number) => number;

/**
 * Width and height from the first start-of-frame marker of a JPEG.
 *
 * @param bytes the file's content
 * @returns the size the marker states; null for anything that is not such a JPEG
 */
export function jpegDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const byteAt: ByteAt = (index) => bytes[index] as number;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = byteAt(offset + 1);
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (byteAt(offset + 2) << 8) | byteAt(offset + 3);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) return frameSize(bytes, offset, byteAt);
    offset += 2 + length;
  }
  return null;
}

/**
 * Whether a marker starts a frame: SOF0 to SOF15 without DHT, JPG and DAC.
 *
 * @param marker the byte after 0xFF
 * @returns true for a start-of-frame marker
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * The size a start-of-frame segment states.
 *
 * @param bytes the file's content
 * @param offset where the segment's marker starts
 * @param byteAt reads one byte of `bytes`
 * @returns the size; null when the segment is cut off or states a zero edge
 */
function frameSize(bytes: Uint8Array, offset: number, byteAt: ByteAt): ImageSize | null {
  if (offset + 9 > bytes.length) return null;
  const height = (byteAt(offset + 5) << 8) | byteAt(offset + 6);
  const width = (byteAt(offset + 7) << 8) | byteAt(offset + 8);
  return width > 0 && height > 0 ? { width, height } : null;
}
