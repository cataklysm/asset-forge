import type { VideoFormat } from '../media-types.js';

/** Reads the pixel size of an image file. Implemented outside core. */
export interface ImageProbe {
  /**
   * Measures an image.
   *
   * @param absolutePath the image file
   * @returns its pixel size; null when it cannot be determined
   */
  measure(absolutePath: string): Promise<{ width: number; height: number } | null>;
}

/** The displayed size (after rotation) and length of a video; `durationMs` is null when unknown. */
export interface VideoInfo {
  /** The displayed width in pixels. */
  width: number;
  /** The displayed height in pixels. */
  height: number;
  /** The length; null when unknown. */
  durationMs: number | null;
}

/** Reads size and length of a video file. Implemented outside core. */
export interface VideoProbe {
  /**
   * Measures a video.
   *
   * @param absolutePath the video file
   * @param format the container, which decides the demuxer
   * @returns its size and length; null when they cannot be determined
   */
  measure(absolutePath: string, format: VideoFormat): Promise<VideoInfo | null>;
}
