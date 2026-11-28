import type { Generation, GenerationKind, GenerationParameters, ProviderKind } from '@assetforge/contracts';
import type { JobOutcome, NewJob } from '../jobs.js';

/** A file a generation read or wrote, as it was then. */
export interface GenerationFileRef {
  fileId: string;
  sha256: string;
  originalName: string;
}

export interface NewGeneration {
  id: string;
  kind: GenerationKind;
  providerId: string;
  /** A copy of the provider name at start. */
  providerName: string;
  providerKind: ProviderKind;
  /** Null for an upscale. */
  model: string | null;
  /** The fully resolved prompt; null for an upscale. */
  prompt: string | null;
  parameters: GenerationParameters;
  /** The library prompt version it was started from; null for an upscale or a free prompt. */
  promptRef: GenerationPromptRef | null;
  createdAt: string;
}

/** A library prompt version as a generation records it; title and number are copies taken at start. */
export interface GenerationPromptRef {
  versionId: string;
  title: string;
  versionNumber: number;
  /** The values by the version's spelling of each variable. */
  variables: Record<string, string>;
}

/** A generation with its input and output files; `jobStatus` is the status of its current job row, null when it is gone. */
export type GenerationRow = Generation;

/**
 * The generations of a workspace. Every transition is guarded by the status it starts from; a purged file
 * reads as `fileId: null` in `inputs` and `outputs`.
 */
export interface GenerationRepository {
  /** One transaction: the generation as `pending`, its input row and the job; `job_id` is the job's id. */
  create(r: { generation: NewGeneration; input: GenerationFileRef; job: NewJob }): Promise<void>;
  get(id: string): Promise<GenerationRow | null>;
  /** The generation whose current job is this one. */
  byJob(jobId: string): Promise<GenerationRow | null>;
  /** The generation that wrote this file. */
  madeBy(fileId: string): Promise<GenerationRow | null>;
  /** The generations that read this file, newest (created_at, then id) first. */
  resultsOf(fileId: string, limit: number): Promise<GenerationRow[]>;
  /** The 1-based rank of this edit among the edits of its input file by (created_at, id); 0 when it is unknown or no edit. */
  editRank(id: string): Promise<number>;
  /** One transaction guarded on `pending`: the output row and `succeeded` with finished_at = now. False otherwise. */
  succeed(r: { id: string; output: GenerationFileRef; now: string }): Promise<boolean>;
  /**
   * Synchronous, for `JobHandler.settled`; changes only a `pending` row and answers whether it did. `failed` sets the
   * code, `cancelled` clears it; a `succeeded` outcome on a still pending row becomes failed `internal_error`.
   */
  settle(r: { id: string; outcome: JobOutcome; now: string }): boolean;
  /**
   * One transaction guarded on `failed` | `cancelled`: inserts the job, sets `pending`, clears the error and finished_at
   * and replaces job_id. False and nothing written otherwise.
   */
  requeue(r: { id: string; job: NewJob; now: string }): Promise<boolean>;
  /** Deletes a `failed` or `cancelled` generation; false otherwise. */
  remove(id: string): Promise<boolean>;
  /** Distinct prompts of edit generations, newest use first. */
  recentPrompts(limit: number): Promise<string[]>;
  /**
   * Every `pending` generation whose job row is gone or finished takes that job's outcome as `settle` does,
   * or failed `provider_outcome_unknown` when the row is gone. Returns how many changed.
   */
  reconcile(now: string): Promise<number>;
}
