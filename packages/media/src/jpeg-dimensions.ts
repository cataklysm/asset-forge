import { FRAME_EDGE } from './video-frame-arguments.js';
import type { Size } from './video-diagnostics.js';

/** True when `frame` is the size the scale filter gives for a video of displayed size `video`. */
export function frameMatches(video: Size, frame: Size): boolean {
  const factor = Math.min(1, FRAME_EDGE / Math.max(video.width, video.height));
  return (
    Math.abs(Math.max(1, Math.round(video.width * factor)) - frame.width) <= 1 &&
    Math.abs(Math.max(1, Math.round(video.height * factor)) - frame.height) <= 1
  );
}

/** Width and height from the first start-of-frame marker of a JPEG; null for anything else. */
export function jpegDimensions(bytes: Uint8Array): Size | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
      const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}
