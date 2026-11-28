import { AnalyzeFilePayloadSchema, type AnalyzeFilePayload, type FileRecord } from '@assetforge/contracts';
import {
  ANALYSIS_PROMPT,
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SCHEMA,
  cleanAnalysisTags,
  composeTaggingRequest,
  isAnalysable,
  LEGACY_TAG_LIMIT,
  MAX_PROMPT_TEXT,
} from './analysis.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './jobs.js';
import type { ModelImageSource, VisionProvider } from './ports/vision-provider.js';
import type { WorkspaceSession } from './session.js';

/** What the `vision.analyze_file` job needs. */
export interface AnalyzeFileHandlerDependencies {
  /** The open workspace. */
  session: WorkspaceSession;
  /** The provider of the job's lane (its entry id) when the job runs; null when that entry does not exist or cannot be used. */
  vision: (lane: string | null) => VisionProvider | null;
  /** Makes the model JPEG of a file. */
  images: ModelImageSource;
  /** The fingerprint provider id of the job's lane; null when the lane has no usable entry. */
  provider: (lane: string | null) => string | null;
  /** Told about the file once its tags or proposal were stored. */
  effects?: JobEffects;
}

/** What Image2Prompt needs. */
export interface DescribeImageDependencies {
  /** The open workspace. */
  session: WorkspaceSession;
  /** The chosen provider; null when it does not exist or cannot be used. */
  vision: () => VisionProvider | null;
  /** Makes the model JPEG of a file. */
  images: ModelImageSource;
}

/** A tagging payload that carries a model (v2 to v4). */
type ModelPayload = Exclude<AnalyzeFilePayload, { version: 1 }>;

/** The text a tagging run sends and what it records. */
interface TaggingRequest {
  /** The prompt sent to the provider. */
  prompt: string;
  /** The most tags kept from the answer. */
  limit: number;
  /** The name of the analysis prompt it came from; null for the legacy prompt. */
  promptName: string | null;
}

/** The model JPEG of a file and the checksum of the content it was made from. */
interface ModelImage {
  /** The JPEG. */
  image: Uint8Array;
  /** The checksum of the file it was made from. */
  sha256: string;
}

/**
 * An analysable file.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns its record
 * @throws `JobError('file_unavailable')` when it is unknown or not analysable
 */
async function loadAnalysable(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await session.database.files.get(fileId);
  if (file === null || !isAnalysable(file)) throw new JobError('file_unavailable');
  return file;
}

/**
 * The model JPEG of a file at its current path.
 *
 * @param session the open workspace
 * @param images makes the JPEG
 * @param file the file
 * @returns the JPEG; null when none could be made from that path
 * @throws `JobError('file_unavailable')` when the path cannot be resolved or the read fails
 */
async function jpegOf(
  session: WorkspaceSession,
  images: ModelImageSource,
  file: FileRecord,
): Promise<Uint8Array | null> {
  try {
    return await images.jpeg(await session.storage.absolutePath(file.relativePath));
  } catch (cause) {
    throw new JobError('file_unavailable', { cause });
  }
}

/**
 * The model JPEG of an analysable file and the checksum of the content it was made from.
 *
 * @param session the open workspace
 * @param images makes the JPEG
 * @param fileId the file
 * @returns the JPEG and the checksum
 * @throws `JobError('file_unavailable')` when the file is unknown, not analysable or no image can be produced
 */
async function readModelImage(
  session: WorkspaceSession,
  images: ModelImageSource,
  fileId: string,
): Promise<ModelImage> {
  let file = await loadAnalysable(session, fileId);
  let image = await jpegOf(session, images, file);
  if (image === null) {
    // The file may have been assigned or moved while it was read: try once more at its new path.
    const again = await loadAnalysable(session, fileId);
    if (again.relativePath === file.relativePath) throw new JobError('file_unavailable');
    file = again;
    image = await jpegOf(session, images, file);
    if (image === null) throw new JobError('file_unavailable');
  }
  return { image, sha256: file.sha256! };
}

/**
 * The handler of `vision.analyze_file`: read the image, ask the provider, then write the AI tags and
 * the analysis record (mode `apply`) or store a proposal (mode `propose`). Holds no database
 * transaction while it reads the image or waits for the provider.
 *
 * @param dependencies the workspace, the providers of the lanes, the image maker and the effects
 * @returns the job handler
 */
export function createAnalyzeFileHandler(dependencies: AnalyzeFileHandlerDependencies): JobHandler {
  return {
    resourceClass: 'local_gpu',
    onInterrupted: 'requeue',
    run(job, signal) {
      return runAnalysis(dependencies, job, signal);
    },
  };
}

/**
 * One tagging run.
 *
 * @param dependencies the workspace, the providers of the lanes, the image maker and the effects
 * @param job the job
 * @param signal aborts the run; a cancelled run never writes
 * @returns resolves once the tags or the proposal are stored
 * @throws `JobError` for every failure
 */
async function runAnalysis(dependencies: AnalyzeFileHandlerDependencies, job: Job, signal: AbortSignal): Promise<void> {
  const { session } = dependencies;
  const parsed = AnalyzeFilePayloadSchema.safeParse(job.payload);
  if (job.fileId === null || !parsed.success) throw new JobError('internal_error');
  const fileId = job.fileId;
  const payload = parsed.data;
  // A v1 row carries no model; it only runs once it was assigned to a provider (and became v4).
  if (payload.version === 1) throw new JobError('provider_not_configured');
  const { model, mode } = payload;
  const request = taggingRequestOf(payload);
  const vision = dependencies.vision(job.lane);
  if (vision === null) throw new JobError('provider_not_configured');
  const provider = dependencies.provider(job.lane);
  if (provider === null) throw new JobError('provider_not_configured');
  const { image, sha256 } = await readModelImage(session, dependencies.images, fileId);
  signal.throwIfAborted();
  const answer = await vision.analyzeImage({ image, prompt: request.prompt, schema: ANALYSIS_SCHEMA, model, signal });
  // Nothing is awaited between this check and the write, so a cancelled run never writes.
  signal.throwIfAborted();
  const tags = cleanAnalysisTags(answer, request.limit);
  if (tags.length === 0) throw new JobError('invalid_response');
  const fingerprint = { provider, model, promptVersion: ANALYSIS_PROMPT_VERSION };
  const { promptName } = request;
  const now = session.now().toISOString();
  const written =
    mode === 'apply'
      ? await session.database.analyses.apply({
          fileId,
          sha256,
          tags: tags.map((tag) => ({ ...tag, newId: session.newId() })),
          ...fingerprint,
          promptName,
          now,
        })
      : await session.database.analyses.propose({ fileId, sha256, tags, ...fingerprint, promptName, createdAt: now });
  if (!written) throw new JobError('file_unavailable');
  reportEffect(dependencies.effects, (effects) => effects.fileChanged(fileId));
}

/**
 * The request of a tagging payload.
 *
 * @param payload a payload with a model
 * @returns for v3 and v4 with a prompt the copied prompt composed with its limit; else the legacy prompt
 */
function taggingRequestOf(payload: ModelPayload): TaggingRequest {
  // v3 and v4 run with the analysis prompt copied at enqueue; v2 and v4 without a prompt with the unchanged legacy prompt.
  const copied = payload.version === 2 ? null : payload.prompt;
  if (copied === null) return { prompt: ANALYSIS_PROMPT, limit: LEGACY_TAG_LIMIT, promptName: null };
  return { prompt: composeTaggingRequest(copied), limit: copied.maxTags, promptName: copied.name };
}

/**
 * Image2Prompt: a paragraph describing the file's image, trimmed and cut at `MAX_PROMPT_TEXT`.
 * `prompt` is sent as it is. Writes nothing.
 *
 * @param dependencies the workspace, the chosen provider and the image maker
 * @param request the file, the model, the prompt and the abort signal
 * @returns the text
 * @throws `JobError` (`provider_not_configured`, `file_unavailable`, `invalid_response` for an empty text, or the
 *   provider's), or the signal's reason when aborted
 */
export async function describeImage(
  dependencies: DescribeImageDependencies,
  request: { fileId: string; model: string; prompt: string; signal: AbortSignal },
): Promise<string> {
  const { signal } = request;
  signal.throwIfAborted();
  const vision = dependencies.vision();
  if (vision === null) throw new JobError('provider_not_configured');
  const { image } = await readModelImage(dependencies.session, dependencies.images, request.fileId);
  signal.throwIfAborted();
  const answer: unknown = await vision.describeImage({ image, prompt: request.prompt, model: request.model, signal });
  signal.throwIfAborted();
  const text = typeof answer === 'string' ? answer.trim().slice(0, MAX_PROMPT_TEXT) : '';
  if (text === '') throw new JobError('invalid_response');
  return text;
}
