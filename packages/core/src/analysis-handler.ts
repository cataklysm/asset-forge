import { AnalyzeFilePayloadSchema, type FileRecord } from '@assetforge/contracts';
import {
  ANALYSIS_PROMPT,
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SCHEMA,
  cleanAnalysisTags,
  IMAGE_PROMPT,
  isAnalysable,
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
  /** The provider in force when a job runs; null when none is configured. */
  vision: () => VisionProvider | null;
  images: ModelImageSource;
  /** Provider id recorded with every analysis. */
  provider: string;
  /** The tagging default model at run time, for v1 payloads; null when none is set. */
  defaultModel: () => string | null;
}): JobHandler {
  const { session: s, images } = deps;

  return {
    resourceClass: 'local_gpu',
    onInterrupted: 'requeue',
    async run(job, signal) {
      const parsed = AnalyzeFilePayloadSchema.safeParse(job.payload);
      if (job.fileId === null || !parsed.success) throw new JobError('internal_error');
      const fileId = job.fileId;
      // v1 rows of phase 4a apply with the default model in force when they run.
      const { model, mode } =
        parsed.data.version === 1 ? { model: deps.defaultModel(), mode: 'apply' as const } : parsed.data;
      const vision = deps.vision();
      if (vision === null || model === null) throw new JobError('provider_not_configured');
      const { image, sha256 } = await readModelImage(s, images, fileId);
      signal.throwIfAborted();
      const answer = await vision.analyzeImage({ image, prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA, model, signal });
      // Nothing is awaited between this check and the write, so a cancelled run never writes.
      signal.throwIfAborted();
      const tags = cleanAnalysisTags(answer);
      if (tags.length === 0) throw new JobError('invalid_response');
      const fingerprint = { provider: deps.provider, model, promptVersion: ANALYSIS_PROMPT_VERSION };
      const now = s.now().toISOString();
      const written =
        mode === 'apply'
          ? await s.database.analyses.apply({ fileId, sha256, tags: tags.map((t) => ({ ...t, newId: s.newId() })), ...fingerprint, now })
          : await s.database.analyses.propose({ fileId, sha256, tags, ...fingerprint, createdAt: now });
      if (!written) throw new JobError('file_unavailable');
    },
  };
}

/**
 * Image2Prompt: a paragraph describing the file's image, trimmed and cut at `MAX_PROMPT_TEXT`.
 * Writes nothing. Rejects with a `JobError` (`provider_not_configured`, `file_unavailable`,
 * `invalid_response` for an empty text, or the provider's), or with the signal's reason when aborted.
 */
export async function describeImage(
  deps: { session: WorkspaceSession; vision: () => VisionProvider | null; images: ModelImageSource },
  r: { fileId: string; model: string; signal: AbortSignal },
): Promise<string> {
  const { signal } = r;
  signal.throwIfAborted();
  const vision = deps.vision();
  if (vision === null) throw new JobError('provider_not_configured');
  const { image } = await readModelImage(deps.session, deps.images, r.fileId);
  signal.throwIfAborted();
  const answer: unknown = await vision.describeImage({ image, prompt: IMAGE_PROMPT, model: r.model, signal });
  signal.throwIfAborted();
  const text = typeof answer === 'string' ? answer.trim().slice(0, MAX_PROMPT_TEXT) : '';
  if (text === '') throw new JobError('invalid_response');
  return text;
}
