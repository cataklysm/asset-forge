import type { Readable } from 'node:stream';
import { EditParametersSchema, ImageGeneratePayloadSchema, UpscaleParametersSchema } from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { SourceNotReadableError } from './errors.js';
import { GENERATION_RESULT_EXTENSIONS, generationNames, settleGenerationOfJob } from './generations.js';
import { importStream, type ImportContext } from './import-file.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './jobs.js';
import type { GenerationImageSource, ImageInput, ImageProviderDirectory } from './ports.js';
import type { WorkspaceSession } from './session.js';

export interface ImageGenerateHandlerDeps {
  session: WorkspaceSession;
  providers: ImageProviderDirectory;
  images: GenerationImageSource;
  /** Told where the linked result ended up: the source's asset (or, for a trashed source, its former one), or the inbox. */
  effects?: JobEffects;
}

/**
 * The `image.generate` job: sends the input image to the generation's provider, imports the answer and links it
 * as the generation's output. Paid work with an unclear outcome is never repeated: an interrupted run fails
 * `provider_outcome_unknown`. The result is linked only once it is a complete file; placing it in the source's
 * asset afterwards (for a source trashed meanwhile, the asset it was in) is best effort and leaves it in the inbox
 * when it fails. The result itself is never trashed.
 */
export function createImageGenerateHandler(deps: ImageGenerateHandlerDeps): JobHandler {
  const s = deps.session;
  // A generation never opens a source file; the answer stream is handed to `importStream` directly.
  const ctx: ImportContext = {
    storage: s.storage,
    storageId: s.storageId,
    files: s.database.files,
    sources: { open: () => Promise.reject(new SourceNotReadableError()) },
    probe: s.imageProbe,
    newId: () => s.newId(),
    now: () => s.now(),
  };

  async function readInput(fileId: string | null, sha256: string, signal: AbortSignal): Promise<{ image: ImageInput; name: string; id: string }> {
    const file = fileId === null ? null : await s.database.files.get(fileId);
    if (file === null || file.status !== 'complete' || file.deletedAt !== null || file.sha256 !== sha256 || file.sizeBytes === null) {
      throw new JobError('file_unavailable');
    }
    let absolutePath: string;
    try {
      absolutePath = await s.storage.absolutePath(file.relativePath);
    } catch (cause) {
      throw new JobError('file_unavailable', { cause });
    }
    const image = await deps.images.read({ absolutePath, mimeType: file.mimeType, sha256, sizeBytes: file.sizeBytes }, signal);
    if (image === null) throw new JobError('file_unavailable');
    return { image, name: file.originalName, id: file.id };
  }

  return {
    resourceClass: 'remote_api',
    onInterrupted: 'fail',
    interruptedCode: 'provider_outcome_unknown',

    async run(job: Job, signal: AbortSignal): Promise<void> {
      const payload = ImageGeneratePayloadSchema.safeParse(job.payload);
      if (!payload.success) throw new JobError('internal_error');
      const generation = await s.database.generations.get(payload.data.generationId);
      if (generation === null || generation.status !== 'pending') throw new JobError('internal_error');
      const input = generation.inputs[0];
      if (input === undefined) throw new JobError('internal_error');

      const source = await readInput(input.fileId, input.sha256, signal);
      const provider = deps.providers.adapter(job.lane ?? generation.providerId);
      if (provider === null) throw new JobError('provider_not_configured');
      signal.throwIfAborted();

      let answer: { stream: Readable; mimeType: string };
      let nameFor: (extension: string) => string;
      if (generation.kind === 'edit') {
        const parameters = EditParametersSchema.safeParse(generation.parameters);
        if (!parameters.success || generation.model === null || generation.prompt === null) throw new JobError('internal_error');
        const rank = await s.database.generations.editRank(generation.id);
        nameFor = (extension) => generationNames.edit(input.name, rank, extension);
        answer = await provider.editImage({
          image: source.image,
          model: generation.model,
          prompt: generation.prompt,
          aspectRatio: parameters.data.aspectRatio,
          resolution: parameters.data.resolution,
          safeMode: parameters.data.safeMode,
          signal,
        });
      } else {
        const parameters = UpscaleParametersSchema.safeParse(generation.parameters);
        if (!parameters.success) throw new JobError('internal_error');
        const scale = parameters.data.scale;
        nameFor = (extension) => generationNames.upscale(input.name, scale, extension);
        answer = await provider.upscaleImage({ image: source.image, scale, signal });
      }
      // Listen at once: an import failure is `provider_outcome_unknown` when the answer stream itself failed,
      // and `generation_result_not_stored` when the answer arrived but could not be kept.
      let streamErrored = false;
      answer.stream.on('error', () => {
        streamErrored = true;
      });
      if (signal.aborted) {
        answer.stream.destroy();
        signal.throwIfAborted();
      }
      // The result is stored under the extension of its own image type; any other answer is not imported.
      const extension = Object.hasOwn(GENERATION_RESULT_EXTENSIONS, answer.mimeType)
        ? GENERATION_RESULT_EXTENSIONS[answer.mimeType]!
        : null;
      if (extension === null) {
        answer.stream.destroy();
        throw new JobError('provider_outcome_unknown');
      }
      const name = nameFor(extension);
      // A failed import discards its row: no failed entry is left in the inbox.
      const imported = await importStream(
        ctx,
        { sourcePath: '', entryName: null, name, stream: answer.stream },
        {
          discardOnFailure: true,
          onStreamError: () => {
            streamErrored = true;
          },
        },
      );
      const file = imported.file;
      if (imported.error !== null || file === null || file.status !== 'complete' || file.sha256 === null) {
        throw new JobError(streamErrored ? 'provider_outcome_unknown' : 'generation_result_not_stored');
      }

      let linked: boolean;
      try {
        linked = await s.database.generations.succeed({
          id: generation.id,
          output: { fileId: file.id, sha256: file.sha256, originalName: file.originalName },
          now: s.now().toISOString(),
        });
      } catch (cause) {
        // The complete result stays unlinked in the inbox; the job fails like an interrupted run.
        throw new JobError('provider_outcome_unknown', { cause });
      }
      // The complete result stays unlinked in the inbox; the paid answer is reported as not stored.
      if (!linked) throw new JobError('generation_result_not_stored');

      let placedIn: string | null = null;
      try {
        const current = await s.database.files.get(source.id);
        // A source trashed while the request ran still hands its result to the asset it was in, when that is left.
        const assetId =
          current === null
            ? null
            : current.assetId ??
              (current.deletedAt !== null &&
              current.trashedAssetId !== null &&
              (await s.database.assets.get(current.trashedAssetId)) !== null
                ? current.trashedAssetId
                : null);
        if (assetId !== null) {
          placedIn = (await relocateFile(s, file.id, { assetId, role: 'generated' })).assetId;
        }
      } catch {
        // Best effort: the linked result stays in the inbox.
      }
      reportEffect(deps.effects, (e) => e.fileAdded(placedIn));
      // The result passed through the inbox, so an inbox page read meanwhile may still hold it.
      if (placedIn !== null) reportEffect(deps.effects, (e) => e.fileAdded(null));
    },

    settled(job: Job, outcome): void {
      settleGenerationOfJob(s, job, outcome);
    },
  };
}
