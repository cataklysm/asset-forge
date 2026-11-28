/** Pixel dimensions of an image, after EXIF orientation. */
export interface ImageSize {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** One preview to render: read `sourcePath`, write an image no larger than `longestEdge` to `targetPath`. */
export interface PreviewJob {
  /** The image read. */
  sourcePath: string;
  /** Where the preview is written. */
  targetPath: string;
  /** The longer edge of the preview at most; smaller images are not enlarged. */
  longestEdge: number;
  /** `webp` is lossy and small, `png` is lossless. */
  format: 'webp' | 'png';
}

/** `none` means no preview could be produced for the source. */
export type PreviewResult = 'ok' | 'none';

/** What a worker is asked to do: render a preview, measure an image or make a JPEG for a vision model. */
export type WorkerJob =
  { kind: 'render'; job: PreviewJob } | { kind: 'measure'; sourcePath: string } | { kind: 'jpeg'; sourcePath: string };

/** One message to a worker. */
export interface WorkerRequest {
  /** Pairs the answer with the request. */
  id: number;
  /** The work. */
  work: WorkerJob;
}

/** A render answers `PreviewResult`; a measurement answers `ImageSize` or `null`; a jpeg answers bytes or `null`. */
export interface WorkerResponse {
  /** The id of the request answered. */
  id: number;
  /** The answer. */
  result: PreviewResult | ImageSize | Uint8Array | null;
}
