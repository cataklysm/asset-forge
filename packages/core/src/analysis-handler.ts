import { AnalyzeFilePayloadSchema, type FileRecord } from '@assetforge/contracts';
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
import { JobError, type JobHandler } from './jobs.js';
import type { ModelImageSource, VisionProvider } from './ports.js';
import type { WorkspaceSession } from './session.js';

/**
 * The model JPEG of an analysable file and the checksum of the content it was made from.
 * `file_unavailable` when the file is unknown, not analysable or no image can be produced.
 */
async function readModelImage(
  s: WorkspaceSession,
  images: ModelImageSource,
  fileId: string,
): Promise<{ image: Uint8Array; sha256: string }> {
  async function load(): Promise<FileRecord> {
    const file = await s.database.files.get(fileId);
    if (file === null || !isAnalysable(file)) throw new JobError('file_unavailable');
    return file;
  }

  async function jpegOf(file: FileRecord): Promise<Uint8Array | null> {
    try {
      return await images.jpeg(await s.storage.absolutePath(file.relativePath));
    } catch (cause) {
      throw new JobError('file_unavailable', { cause });
    }
  }

  let file = await load();
  let image = await jpegOf(file);
  if (image === null) {
    // The file may have been assigned or moved while it was read: try once more at its new path.
    const again = await load();
    if (again.relativePath === file.relativePath) throw new JobError('file_unavailable');
    file = again;
    image = await jpegOf(file);
    if (image === null) throw new JobError('file_unavailable');
  }
  return { image, sha256: file.sha256! };
}

/**
 * The handler of `vision.analyze_file`: read the image, ask the provider, then write the AI tags and
 * the analysis record (mode `apply`) or store a proposal (mode `propose`). Holds no database
 * transaction while it reads the image or waits for the provider.
 */
export function createAnalyzeFileHandler(deps: {
  session: WorkspaceSession;
  /** The provider of the job's lane (its entry id) when the job runs; null when that entry does not exist or cannot be used. */
  vision: (lane: string | null) => VisionProvider | null;
  images: ModelImageSource;
  /** Adapter kind recorded in the fingerprint of every analysis. */
  provider: string;
}): JobHandler {
  const { session: s, images } = deps;

  return {
    resourceClass: 'local_gpu',
    onInterrupted: 'requeue',
    async run(job, signal) {
      const parsed = AnalyzeFilePayloadSchema.safeParse(job.payload);
      if (job.fileId === null || !parsed.success) throw new JobError('internal_error');
      const fileId = job.fileId;
      const payload = parsed.data;
      // A v1 row carries no model; it only runs once it was assigned to a provider (and became v4).
      if (payload.version === 1) throw new JobError('provider_not_configured');
      const { model, mode } = payload;
      // v3 and v4 run with the analysis prompt copied at enqueue; v2 and v4 without a prompt with the unchanged legacy prompt.
      const copied = payload.version === 2 ? null : payload.prompt;
      const request =
        copied !== null
          ? { prompt: composeTaggingRequest(copied), limit: copied.maxTags, promptName: copied.name }
          : { prompt: ANALYSIS_PROMPT, limit: LEGACY_TAG_LIMIT, promptName: null };
      const vision = deps.vision(job.lane);
      if (vision === null) throw new JobError('provider_not_configured');
      const { image, sha256 } = await readModelImage(s, images, fileId);
      signal.throwIfAborted();
      const answer = await vision.analyzeImage({ image, prompt: request.prompt, schema: ANALYSIS_SCHEMA, model, signal });
      // Nothing is awaited between this check and the write, so a cancelled run never writes.
      signal.throwIfAborted();
      const tags = cleanAnalysisTags(answer, request.limit);
      if (tags.length === 0) throw new JobError('invalid_response');
      const fingerprint = { provider: deps.provider, model, promptVersion: ANALYSIS_PROMPT_VERSION };
      const { promptName } = request;
      const now = s.now().toISOString();
      const written =
        mode === 'apply'
          ? await s.database.analyses.apply({ fileId, sha256, tags: tags.map((t) => ({ ...t, newId: s.newId() })), ...fingerprint, promptName, now })
          : await s.database.analyses.propose({ fileId, sha256, tags, ...fingerprint, promptName, createdAt: now });
      if (!written) throw new JobError('file_unavailable');
    },
  };
}

/**
 * Image2Prompt: a paragraph describing the file's image, trimmed and cut at `MAX_PROMPT_TEXT`.
 * `prompt` is sent as it is. Writes nothing. Rejects with a `JobError` (`provider_not_configured`, `file_unavailable`,
 * `invalid_response` for an empty text, or the provider's), or with the signal's reason when aborted.
 */
export async function describeImage(
  deps: { session: WorkspaceSession; vision: () => VisionProvider | null; images: ModelImageSource },
  r: { fileId: string; model: string; prompt: string; signal: AbortSignal },
): Promise<string> {
  const { signal } = r;
  signal.throwIfAborted();
  const vision = deps.vision();
  if (vision === null) throw new JobError('provider_not_configured');
  const { image } = await readModelImage(deps.session, deps.images, r.fileId);
  signal.throwIfAborted();
  const answer: unknown = await vision.describeImage({ image, prompt: r.prompt, model: r.model, signal });
  signal.throwIfAborted();
  const text = typeof answer === 'string' ? answer.trim().slice(0, MAX_PROMPT_TEXT) : '';
  if (text === '') throw new JobError('invalid_response');
  return text;
}
