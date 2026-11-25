/** One preview to render: read `sourcePath`, write a WebP no larger than `longestEdge` to `targetPath`. */
export interface PreviewJob {
  sourcePath: string;
  targetPath: string;
  longestEdge: number;
}

/** `none` means no preview could be produced for the source. */
export type PreviewResult = 'ok' | 'none';

export interface WorkerRequest {
  id: number;
  job: PreviewJob;
}

export interface WorkerResponse {
  id: number;
  result: PreviewResult;
}
