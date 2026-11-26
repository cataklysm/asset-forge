import {
  ANALYZE_FILE_JOB,
  AnalyzeFilePayloadSchema,
  cleanTagText,
  normalizeTagName,
  type AnalysisSkipReason,
  type EnqueueAnalysisResult,
  type FileRecord,
} from '@assetforge/contracts';
import { JobError, type JobHandler, type NewJob } from './jobs.js';
import { isPreviewable } from './media-types.js';
import type { ModelImageSource, VisionProvider } from './ports.js';
import type { WorkspaceSession } from './session.js';

export const ANALYSIS_PROMPT_VERSION = 1;

export const ANALYSIS_PROMPT = [
  'Describe this image with 8 to 15 short tags in English, all in lower case.',
  'Cover what is shown, the materials and the dominant colours.',
  'Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".',
  'Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".',
  'Answer only with JSON of the form {"tags": ["...", "..."]}.',
].join('\n');

/** JSON schema of the answer, passed to the provider as its output format. */
export const ANALYSIS_SCHEMA: unknown = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
  additionalProperties: false,
};

export const MAX_ANALYSIS_TAGS = 20;

/**
 * The usable tags of a provider answer, in order, distinct by normalised name, at most 20; [] when
 * the answer has no usable tag. The answer is untrusted: anything but an object with a `tags` array
 * yields []; entries that are not strings or not valid tags are dropped.
 */
export function cleanAnalysisTags(answer: unknown): { name: string; displayName: string }[] {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return [];
  const entries: unknown = (answer as { tags?: unknown }).tags;
  if (!Array.isArray(entries)) return [];
  const result: { name: string; displayName: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (result.length === MAX_ANALYSIS_TAGS) break;
    if (typeof entry !== 'string') continue;
    const name = normalizeTagName(entry);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, displayName: cleanTagText(entry) });
  }
  return result;
}

/** Complete, of a previewable MIME type and with a checksum. */
export function isAnalysable(file: FileRecord): boolean {
  return file.status === 'complete' && isPreviewable(file.mimeType) && file.sha256 !== null;
}

/**
 * One analysis job per analysable file, in request order. Not all or nothing: unknown and
 * unanalysable files and files that already have an active analysis job are reported as skipped.
 */
export async function enqueueAnalysis(
  s: WorkspaceSession,
  r: { fileIds: readonly string[] },
): Promise<EnqueueAnalysisResult> {
  const entries: { fileId: string; reason: AnalysisSkipReason | null; job: NewJob | null }[] = [];
  for (const fileId of r.fileIds) {
    const file = await s.database.files.get(fileId);
    if (file === null) {
      entries.push({ fileId, reason: 'not_found', job: null });
    } else if (!isAnalysable(file)) {
      entries.push({ fileId, reason: 'not_analysable', job: null });
    } else {
      const job: NewJob = {
        id: s.newId(),
        type: ANALYZE_FILE_JOB,
        resourceClass: 'local_gpu',
        fileId,
        payload: { version: 1 },
        dedupeKey: `${ANALYZE_FILE_JOB}:${fileId}`,
      };
      entries.push({ fileId, reason: null, job });
    }
  }
  const jobs = entries.flatMap((e) => (e.job === null ? [] : [e.job]));
  const inserted = new Set(jobs.length === 0 ? [] : await s.database.jobs.enqueue({ jobs, now: s.now().toISOString() }));
  const skipped: EnqueueAnalysisResult['skipped'] = [];
  for (const e of entries) {
    if (e.reason !== null) skipped.push({ fileId: e.fileId, reason: e.reason });
    else if (!inserted.has(e.job!.id)) skipped.push({ fileId: e.fileId, reason: 'already_queued' });
  }
  return { enqueued: inserted.size, skipped };
}

/**
 * The handler of `vision.analyze_file`: read the image, ask the provider, write the AI tags and the
 * analysis record. Holds no database transaction while it reads the image or waits for the provider.
 */
export function createAnalyzeFileHandler(deps: {
  session: WorkspaceSession;
  vision: VisionProvider;
  images: ModelImageSource;
  provider: string;
  model: string;
}): JobHandler {
  const { session: s, vision, images } = deps;

  async function load(fileId: string): Promise<FileRecord> {
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

  /** Step 1: the JPEG and the checksum of the content it was made from. */
  async function read(fileId: string): Promise<{ image: Uint8Array; sha256: string }> {
    let file = await load(fileId);
    let image = await jpegOf(file);
    if (image === null) {
      // The file may have been assigned or moved while it was read: try once more at its new path.
      const again = await load(fileId);
      if (again.relativePath === file.relativePath) throw new JobError('file_unavailable');
      file = again;
      image = await jpegOf(file);
      if (image === null) throw new JobError('file_unavailable');
    }
    return { image, sha256: file.sha256! };
  }

  return {
    resourceClass: 'local_gpu',
    onInterrupted: 'requeue',
    async run(job, signal) {
      if (job.fileId === null || !AnalyzeFilePayloadSchema.safeParse(job.payload).success) {
        throw new JobError('internal_error');
      }
      const { image, sha256 } = await read(job.fileId);
      signal.throwIfAborted();
      const answer = await vision.analyzeImage({ image, prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA, signal });
      // Nothing is awaited between this check and the write, so a cancelled run never writes.
      signal.throwIfAborted();
      const tags = cleanAnalysisTags(answer);
      if (tags.length === 0) throw new JobError('invalid_response');
      const applied = await s.database.analyses.apply({
        fileId: job.fileId,
        sha256,
        tags: tags.map((t) => ({ ...t, newId: s.newId() })),
        provider: deps.provider,
        model: deps.model,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        now: s.now().toISOString(),
      });
      if (!applied) throw new JobError('file_unavailable');
    },
  };
}
