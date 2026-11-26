/** Pixel dimensions of an image, after EXIF orientation. */
export interface ImageSize {
  width: number;
  height: number;
}

/** One preview to render: read `sourcePath`, write an image no larger than `longestEdge` to `targetPath`. */
export interface PreviewJob {
  sourcePath: string;
  targetPath: string;
  longestEdge: number;
  /** `webp` is lossy and small, `png` is lossless. */
  format: 'webp' | 'png';
}

/** `none` means no preview could be produced for the source. */
export type PreviewResult = 'ok' | 'none';

export type WorkerJob =
  | { kind: 'render'; job: PreviewJob }
  | { kind: 'measure'; sourcePath: string }
  | { kind: 'jpeg'; sourcePath: string };

export interface WorkerRequest {
  id: number;
  work: WorkerJob;
}

/** A render answers `PreviewResult`; a measurement answers `ImageSize` or `null`; a jpeg answers bytes or `null`. */
export interface WorkerResponse {
  id: number;
  result: PreviewResult | ImageSize | Uint8Array | null;
}
