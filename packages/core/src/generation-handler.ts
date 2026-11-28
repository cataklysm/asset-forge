import type { Readable } from 'node:stream';
import {
  EditParametersSchema,
  ImageGeneratePayloadSchema,
  UpscaleParametersSchema,
  type FileRecord,
  type Generation,
} from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { GENERATION_RESULT_EXTENSIONS, generationNames } from './generation-names.js';
import { settleGenerationOfJob } from './generations.js';
import { streamImportContextOf } from './import-context.js';
import { importStream, type ImportContext } from './import-file.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './job-types.js';
import type {
  GenerationImageSource,
  ImageInput,
  ImageProvider,
  ImageProviderDirectory,
} from './ports/image-provider.js';
import type { WorkspaceSession } from './session.js';

/** What the `image.generate` job needs. */
export interface ImageGenerateHandlerDependencies {
  /** The open workspace. */
  session: WorkspaceSession;
  /** The image provider entries and their adapters. */
  providers: ImageProviderDirectory;
  /** Reads the image that is sent. */
  images: GenerationImageSource;
  /** Told where the linked result ended up: the source's asset (or, for a trashed source, its former one), or the inbox. */
  effects?: JobEffects;
}

/** The provider's answer: the result image as a stream. */
interface ProviderAnswer {
  /** The result image. */
  stream: Readable;
  /** Its MIME type as the provider reports it. */
  mimeType: string;
}

/** The answer of a paid request and how its result is named. */
interface RequestedResult {
  /** The provider's answer. */
  answer: ProviderAnswer;
  /**
   * The result's file name.
   *
   * @param extension the extension of the result's image type
   * @returns the name
   */
  nameFor: (extension: string) => string;
}

/** The source image as it is sent. */
interface ReadInput {
  /** The image to send. */
  image: ImageInput;
  /** The source file's name. */
  name: string;
  /** The source file's id. */
  id: string;
}

/** Whether the answer stream failed; set by the stream's own listener and by the import. */
interface StreamState {
  /** True once the answer stream reported an error. */
  errored: boolean;
}

/**
 * The `image.generate` job: sends the input image to the generation's provider, imports the answer and links it
 * as the generation's output. Paid work with an unclear outcome is never repeated: an interrupted run fails
 * `provider_outcome_unknown`. The result is linked only once it is a complete file; placing it in the source's
 * asset afterwards (for a source trashed meanwhile, the asset it was in) is best effort and leaves it in the inbox
 * when it fails. The result itself is never trashed.
 *
 * @param dependencies the workspace, the providers, the image reader and the effects
 * @returns the job handler
 */
export function createImageGenerateHandler(dependencies: ImageGenerateHandlerDependencies): JobHandler {
  const { session } = dependencies;
  // A generation never opens a source file; the answer stream is handed to `importStream` directly.
  const context = streamImportContextOf(session);
  return {
    resourceClass: 'remote_api',
    onInterrupted: 'fail',
    interruptedCode: 'provider_outcome_unknown',

    run(job: Job, signal: AbortSignal): Promise<void> {
      return runGeneration(dependencies, context, job, signal);
    },

    settled(job: Job, outcome): void {
      settleGenerationOfJob(session, job, outcome);
    },
  };
}

/**
 * One run: reads the input, sends the paid request, imports and links the result, then places it.
 *
 * @param dependencies the workspace, the providers, the image reader and the effects
 * @param context the import context of results
 * @param job the job
 * @param signal aborts the run
 * @returns resolves once the result is linked
 * @throws `JobError` for every failure; the answer is never requested twice
 */
async function runGeneration(
  dependencies: ImageGenerateHandlerDependencies,
  context: ImportContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const { session } = dependencies;
  const generation = await pendingGeneration(session, job);
  const input = generation.inputs[0];
  if (input === undefined) throw new JobError('internal_error');

  const source = await readInput(dependencies, input.fileId, input.sha256, signal);
  const provider = dependencies.providers.adapter(job.lane ?? generation.providerId);
  if (provider === null) throw new JobError('provider_not_configured');
  signal.throwIfAborted();

  const { answer, nameFor } = await requestResult(session, provider, generation, input.name, source.image, signal);
  // Listen at once: an import failure is `provider_outcome_unknown` when the answer stream itself failed,
  // and `generation_result_not_stored` when the answer arrived but could not be kept.
  const streamState: StreamState = { errored: false };
  answer.stream.on('error', () => {
    streamState.errored = true;
  });
  if (signal.aborted) {
    answer.stream.destroy();
    signal.throwIfAborted();
  }
  const extension = resultExtension(answer);
  const file = await importAnswer(context, answer, nameFor(extension), streamState);
  await linkResult(session, generation.id, file);

  const placedIn = await placeResult(session, source.id, file.id);
  reportEffect(dependencies.effects, (effects) => effects.fileAdded(placedIn));
  // The result passed through the inbox, so an inbox page read meanwhile may still hold it.
  if (placedIn !== null) reportEffect(dependencies.effects, (effects) => effects.fileAdded(null));
}

/**
 * The pending generation a job runs.
 *
 * @param session the open workspace
 * @param job the job
 * @returns the generation
 * @throws `JobError('internal_error')` for a broken payload or a generation that is gone or no longer pending
 */
async function pendingGeneration(session: WorkspaceSession, job: Job): Promise<Generation> {
  const payload = ImageGeneratePayloadSchema.safeParse(job.payload);
  if (!payload.success) throw new JobError('internal_error');
  const generation = await session.database.generations.get(payload.data.generationId);
  if (generation === null || generation.status !== 'pending') throw new JobError('internal_error');
  return generation;
}

/**
 * Reads the image to send: the source must still be complete, outside the trash and of the stored content.
 *
 * @param dependencies the workspace and the image reader
 * @param fileId the source file; null once it was purged
 * @param sha256 the checksum the generation was started with
 * @param signal aborts the read
 * @returns the image, the source's name and its id
 * @throws `JobError('file_unavailable')` when the source cannot be sent
 */
async function readInput(
  dependencies: ImageGenerateHandlerDependencies,
  fileId: string | null,
  sha256: string,
  signal: AbortSignal,
): Promise<ReadInput> {
  const { session } = dependencies;
  const file = fileId === null ? null : await session.database.files.get(fileId);
  if (
    file === null ||
    file.status !== 'complete' ||
    file.deletedAt !== null ||
    file.sha256 !== sha256 ||
    file.sizeBytes === null
  ) {
    throw new JobError('file_unavailable');
  }
  let absolutePath: string;
  try {
    absolutePath = await session.storage.absolutePath(file.relativePath);
  } catch (cause) {
    throw new JobError('file_unavailable', { cause });
  }
  const image = await dependencies.images.read(
    { absolutePath, mimeType: file.mimeType, sha256, sizeBytes: file.sizeBytes },
    signal,
  );
  if (image === null) throw new JobError('file_unavailable');
  return { image, name: file.originalName, id: file.id };
}

/**
 * Sends the paid request of an edit or an upscale.
 *
 * @param session the open workspace
 * @param provider the adapter of the generation's entry
 * @param generation the pending generation
 * @param sourceName the stored name of the source
 * @param image the image to send
 * @param signal aborts the request
 * @returns the answer and how the result is named
 * @throws `JobError('internal_error')` for stored parameters that do not parse
 */
async function requestResult(
  session: WorkspaceSession,
  provider: ImageProvider,
  generation: Generation,
  sourceName: string,
  image: ImageInput,
  signal: AbortSignal,
): Promise<RequestedResult> {
  if (generation.kind === 'edit') return requestEdit(session, provider, generation, sourceName, image, signal);
  const parameters = UpscaleParametersSchema.safeParse(generation.parameters);
  if (!parameters.success) throw new JobError('internal_error');
  const scale = parameters.data.scale;
  const nameFor = (extension: string) => generationNames.upscale(sourceName, scale, extension);
  const answer = await provider.upscaleImage({ image, scale, signal });
  return { answer, nameFor };
}

/**
 * Sends the paid request of an edit; its result is named after the edit's rank among the source's edits.
 *
 * @param session the open workspace
 * @param provider the adapter of the generation's entry
 * @param generation the pending edit
 * @param sourceName the stored name of the source
 * @param image the image to send
 * @param signal aborts the request
 * @returns the answer and how the result is named
 * @throws `JobError('internal_error')` for stored parameters, model or prompt that are missing
 */
async function requestEdit(
  session: WorkspaceSession,
  provider: ImageProvider,
  generation: Generation,
  sourceName: string,
  image: ImageInput,
  signal: AbortSignal,
): Promise<RequestedResult> {
  const parameters = EditParametersSchema.safeParse(generation.parameters);
  if (!parameters.success || generation.model === null || generation.prompt === null)
    throw new JobError('internal_error');
  const rank = await session.database.generations.editRank(generation.id);
  const nameFor = (extension: string) => generationNames.edit(sourceName, rank, extension);
  const answer = await provider.editImage({
    image,
    model: generation.model,
    prompt: generation.prompt,
    aspectRatio: parameters.data.aspectRatio,
    resolution: parameters.data.resolution,
    safeMode: parameters.data.safeMode,
    signal,
  });
  return { answer, nameFor };
}

/**
 * The extension the result is stored under.
 *
 * @param answer the provider's answer
 * @returns the extension of its image type
 * @throws `JobError('provider_outcome_unknown')` for any other type; the answer stream is destroyed then
 */
function resultExtension(answer: ProviderAnswer): string {
  // The result is stored under the extension of its own image type; any other answer is not imported.
  const extension = Object.hasOwn(GENERATION_RESULT_EXTENSIONS, answer.mimeType)
    ? GENERATION_RESULT_EXTENSIONS[answer.mimeType]!
    : null;
  if (extension === null) {
    answer.stream.destroy();
    throw new JobError('provider_outcome_unknown');
  }
  return extension;
}

/**
 * Imports the answer into the inbox.
 *
 * @param context the import context of results
 * @param answer the provider's answer
 * @param name the result's file name
 * @param streamState set when the answer stream fails during the import
 * @returns the complete file
 * @throws `JobError('provider_outcome_unknown')` when the answer stream failed, else
 *   `JobError('generation_result_not_stored')`
 */
async function importAnswer(
  context: ImportContext,
  answer: ProviderAnswer,
  name: string,
  streamState: StreamState,
): Promise<FileRecord & { sha256: string }> {
  // A failed import discards its row: no failed entry is left in the inbox.
  const imported = await importStream(
    context,
    { sourcePath: '', entryName: null, name, stream: answer.stream },
    {
      discardOnFailure: true,
      onStreamError: () => {
        streamState.errored = true;
      },
    },
  );
  const file = imported.file;
  if (imported.error !== null || file === null || file.status !== 'complete' || file.sha256 === null) {
    throw new JobError(streamState.errored ? 'provider_outcome_unknown' : 'generation_result_not_stored');
  }
  return { ...file, sha256: file.sha256 };
}

/**
 * Links the complete result as the generation's output.
 *
 * @param session the open workspace
 * @param generationId the generation
 * @param file the complete result
 * @returns resolves once it is linked
 * @throws `JobError('provider_outcome_unknown')` when the write fails, `JobError('generation_result_not_stored')`
 *   when the generation is no longer pending
 */
async function linkResult(
  session: WorkspaceSession,
  generationId: string,
  file: FileRecord & { sha256: string },
): Promise<void> {
  let linked: boolean;
  try {
    linked = await session.database.generations.succeed({
      id: generationId,
      output: { fileId: file.id, sha256: file.sha256, originalName: file.originalName },
      now: session.now().toISOString(),
    });
  } catch (cause) {
    // The complete result stays unlinked in the inbox; the job fails like an interrupted run.
    throw new JobError('provider_outcome_unknown', { cause });
  }
  // The complete result stays unlinked in the inbox; the paid answer is reported as not stored.
  if (!linked) throw new JobError('generation_result_not_stored');
}

/**
 * Moves the linked result into the source's asset with the role `generated`; best effort.
 *
 * @param session the open workspace
 * @param sourceId the source file
 * @param fileId the result
 * @returns the asset it was placed in; null when it stays in the inbox
 */
async function placeResult(session: WorkspaceSession, sourceId: string, fileId: string): Promise<string | null> {
  try {
    const assetId = await resultAssetOf(session, sourceId);
    if (assetId === null) return null;
    return (await relocateFile(session, fileId, { assetId, role: 'generated' })).assetId;
  } catch {
    // Best effort: the linked result stays in the inbox.
    return null;
  }
}

/**
 * The asset a result goes to.
 *
 * @param session the open workspace
 * @param sourceId the source file
 * @returns the source's asset; for a trashed source the asset it was in when that still exists; else null
 */
async function resultAssetOf(session: WorkspaceSession, sourceId: string): Promise<string | null> {
  const current = await session.database.files.get(sourceId);
  if (current === null) return null;
  if (current.assetId !== null) return current.assetId;
  // A source trashed while the request ran still hands its result to the asset it was in, when that is left.
  if (current.deletedAt === null || current.trashedAssetId === null) return null;
  return (await session.database.assets.get(current.trashedAssetId)) !== null ? current.trashedAssetId : null;
}
