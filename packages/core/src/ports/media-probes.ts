import type { VideoFormat } from '../media-types.js';

/** Reads the pixel size of an image file; null when it cannot be determined. Implemented outside core. */
export interface ImageProbe {
  measure(absolutePath: string): Promise<{ width: number; height: number } | null>;
}

/** The displayed size (after rotation) and length of a video; `durationMs` is null when unknown. */
export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number | null;
}

/** Reads size and length of a video file; null when they cannot be determined. Implemented outside core. */
export interface VideoProbe {
  measure(absolutePath: string, format: VideoFormat): Promise<VideoInfo | null>;
}
