import type { Generation, GenerationKind, GenerationParameters, ProviderKind } from '@assetforge/contracts';
import type { JobOutcome, NewJob } from '../job-types.js';

/** A file a generation read or wrote, as it was then. */
export interface GenerationFileRef {
  /** The file; read back as null once it is purged. */
  fileId: string;
  /** Its checksum at the time, kept when the file is purged. */
  sha256: string;
  /** Its name at the time, kept when the file is purged. */
  originalName: string;
}

/** A generation as a start writes it; never holds a credential or a URL. */
export interface NewGeneration {
  /** The id of the generation. */
  id: string;
  /** Edit or upscale. */
  kind: GenerationKind;
  /** The provider entry the job runs on. */
  providerId: string;
  /** A copy of the provider name at start. */
  providerName: string;
  /** A copy of the provider entry's kind at start. */
  providerKind: ProviderKind;
  /** Null for an upscale. */
  model: string | null;
  /** The fully resolved prompt; null for an upscale. */
  prompt: string | null;
  /** The effective, versioned parameters. */
  parameters: GenerationParameters;
  /** The library prompt version it was started from; null for an upscale or a free prompt. */
  promptRef: GenerationPromptRef | null;
  /** When the generation was started. */
  createdAt: string;
}

/** A library prompt version as a generation records it; title and number are copies taken at start. */
export interface GenerationPromptRef {
  /** The prompt version; the stored link is cleared when the prompt is deleted. */
  versionId: string;
  /** A copy of the prompt title. */
  title: string;
  /** A copy of the version number. */
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
  /**
   * One transaction: the generation as `pending`, its input row and the job; `job_id` is the job's id.
   *
   * @param start the generation, its input file and its job
   */
  create(start: { generation: NewGeneration; input: GenerationFileRef; job: NewJob }): Promise<void>;
  /**
   * One generation.
   *
   * @param id the generation
   * @returns the generation; null for an unknown id
   */
  get(id: string): Promise<GenerationRow | null>;
  /**
   * The generation whose current job is this one.
   *
   * @param jobId the job
   * @returns the generation; null when no generation has this job
   */
  byJob(jobId: string): Promise<GenerationRow | null>;
  /**
   * The generation that wrote this file.
   *
   * @param fileId the output file
   * @returns the generation; null when the file is no generation's output
   */
  madeBy(fileId: string): Promise<GenerationRow | null>;
  /**
   * The generations that read this file, newest (created_at, then id) first.
   *
   * @param fileId the input file
   * @param limit the most generations to answer
   * @returns the generations
   */
  resultsOf(fileId: string, limit: number): Promise<GenerationRow[]>;
  /**
   * The rank of an edit among the edits of its input file, which numbers the result's name.
   *
   * @param id the generation
   * @returns the 1-based rank by (created_at, id); 0 when it is unknown or no edit
   */
  editRank(id: string): Promise<number>;
  /**
   * One transaction guarded on `pending`: the output row and `succeeded` with finished_at = now.
   *
   * @param success the generation, its output file and the time
   * @returns false when the row is not `pending`
   */
  succeed(success: { id: string; output: GenerationFileRef; now: string }): Promise<boolean>;
  /**
   * Synchronous, for `JobHandler.settled`; changes only a `pending` row. `failed` sets the code, `cancelled` clears
   * it; a `succeeded` outcome on a still pending row becomes failed `internal_error`.
   *
   * @param settlement the generation, the job's outcome and the time
   * @returns whether the row changed
   */
  settle(settlement: { id: string; outcome: JobOutcome; now: string }): boolean;
  /**
   * One transaction guarded on `failed` | `cancelled`: inserts the job, sets `pending`, clears the error and finished_at
   * and replaces job_id.
   *
   * @param retry the generation, its new job and the time
   * @returns false, writing nothing, when the row is not failed or cancelled
   */
  requeue(retry: { id: string; job: NewJob; now: string }): Promise<boolean>;
  /**
   * Deletes a `failed` or `cancelled` generation.
   *
   * @param id the generation
   * @returns false when it is unknown or in another status
   */
  remove(id: string): Promise<boolean>;
  /**
   * Distinct prompts of edit generations, newest use first.
   *
   * @param limit the most prompts to answer
   * @returns the prompt texts
   */
  recentPrompts(limit: number): Promise<string[]>;
  /**
   * Every `pending` generation whose job row is gone or finished takes that job's outcome as `settle` does,
   * or failed `provider_outcome_unknown` when the row is gone.
   *
   * @param now the time
   * @returns how many generations changed
   */
  reconcile(now: string): Promise<number>;
}
