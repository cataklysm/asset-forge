import type { JobErrorCode, JobStatus, ResourceClass } from '@assetforge/contracts';

/** A persistent job row. `payload` is the parsed JSON; each job type validates it with its own schema. */
export interface Job {
  id: string;
  type: string;
  resourceClass: ResourceClass;
  status: JobStatus;
  fileId: string | null;
  payload: unknown;
  dedupeKey: string | null;
  /** Number of started runs. */
  attempt: number;
  runAfter: string | null;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  /** Start of the latest run. */
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface NewJob {
  id: string;
  type: string;
  resourceClass: ResourceClass;
  fileId: string | null;
  payload: unknown;
  dedupeKey: string | null;
}
