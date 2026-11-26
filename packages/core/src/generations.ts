import {
  GENERATION_PROMPT_MAX,
  IMAGE_GENERATE_JOB,
  IMAGE_INPUT_MAX_PIXELS,
  IMAGE_INPUT_MIN_PIXELS,
  MAX_FILE_GENERATIONS,
  MAX_RECENT_PROMPTS,
  UPSCALE_MAX_PIXELS,
  type FileRecord,
  type Generation,
  type GenerationParameters,
  type ImageGeneratePayload,
  type StartGeneration,
  type StartGenerationResult,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ProviderNotConfiguredError, ValidationFailedError } from './errors.js';
import type { JobControl, NewJob } from './jobs.js';
import { measureFile } from './measure-file.js';
import { isPreviewable } from './media-types.js';
import type { ImageProviderDirectory } from './ports.js';
import type { WorkspaceSession } from './session.js';

/** What the generation use cases need beyond the session. */
export interface GenerationDeps {
  providers: ImageProviderDirectory;
  control: JobControl;
}

const NOT_USABLE = 'Only a complete image outside the trash can be used';
const NOT_FOUND = 'This generation does not exist';

/** True when a generation may read this file: complete, outside the trash and previewable (SVG excluded). */
function isUsableInput(file: FileRecord): boolean {
  return file.status === 'complete' && file.deletedAt === null && isPreviewable(file.mimeType);
}

function generationJob(s: WorkspaceSession, generationId: string, fileId: string, providerId: string): NewJob {
  const payload: ImageGeneratePayload = { v: 1, generationId };
  return { id: s.newId(), type: IMAGE_GENERATE_JOB, resourceClass: 'remote_api', fileId, lane: providerId, payload, dedupeKey: null };
}

async function requireGeneration(s: WorkspaceSession, id: string): Promise<Generation> {
  const generation = await s.database.generations.get(id);
  if (generation === null) throw new NotFoundError(NOT_FOUND);
  return generation;
}

/**
 * Starts an edit or an upscale of one image. Checks in this order: the file, its pixel size, the provider,
 * then for an edit the prompt and the model's offer (the only step that asks the provider), for an upscale
 * the result size. A model list that cannot be loaded is answered as `{ ok: false, code }`; every other
 * refusal throws, and nothing is queued then.
 */
export async function startGeneration(
  s: WorkspaceSession,
  deps: GenerationDeps,
  input: StartGeneration,
): Promise<StartGenerationResult> {
  let file = await s.database.files.get(input.fileId);
  if (file === null) throw new NotFoundError('File not found');
  if (!isUsableInput(file)) throw new InvalidOperationError(NOT_USABLE);
  if (file.width === null || file.height === null) file = await measureFile(s, file.id);
  const { width, height } = file;
  if (width === null || height === null || width * height < IMAGE_INPUT_MIN_PIXELS || width * height > IMAGE_INPUT_MAX_PIXELS) {
    throw new InvalidOperationError('This image cannot be sent to the provider');
  }

  const entry = deps.providers.resolve(input.providerId);
  if (entry === null) throw new ProviderNotConfiguredError('No provider is configured');

  let model: string | null = null;
  let prompt: string | null = null;
  let parameters: GenerationParameters;
  if (input.kind === 'edit') {
    prompt = input.prompt.trim();
    if (prompt.length < 1 || prompt.length > GENERATION_PROMPT_MAX) {
      throw new ValidationFailedError(`The prompt must have 1 to ${GENERATION_PROMPT_MAX} characters`);
    }
    const listed = await deps.providers.models(entry.id, new AbortController().signal);
    if (!listed.ok) return { ok: false, code: listed.code };
    const offer = listed.models.find((m) => m.name === input.model);
    if (offer === undefined) throw new ValidationFailedError('This model is not offered by the provider');
    if (offer.promptCharacterLimit !== null && prompt.length > offer.promptCharacterLimit) {
      throw new ValidationFailedError('The prompt is longer than this model allows');
    }
    if (input.aspectRatio !== undefined && offer.aspectRatios !== null && !offer.aspectRatios.includes(input.aspectRatio)) {
      throw new ValidationFailedError('This aspect ratio is not offered by the model');
    }
    if (input.resolution !== undefined && offer.resolutions !== null && !offer.resolutions.includes(input.resolution)) {
      throw new ValidationFailedError('This resolution is not offered by the model');
    }
    model = offer.name;
    parameters = { v: 1, aspectRatio: input.aspectRatio ?? null, resolution: input.resolution ?? null, safeMode: input.safeMode };
  } else {
    if (width * input.scale * (height * input.scale) > UPSCALE_MAX_PIXELS) {
      throw new InvalidOperationError('The upscaled image would be too large');
    }
    parameters = { v: 1, scale: input.scale };
  }

  const id = s.newId();
  await s.database.generations.create({
    generation: {
      id,
      kind: input.kind,
      providerId: entry.id,
      providerName: entry.name,
      providerKind: 'venice',
      model,
      prompt,
      parameters,
      createdAt: s.now().toISOString(),
    },
    // A complete file always has a checksum.
    input: { fileId: file.id, sha256: file.sha256!, originalName: file.originalName },
    job: generationJob(s, id, file.id, entry.id),
  });
  deps.providers.markUsed(entry.id);
  deps.control.wake();
  return { ok: true, generation: await requireGeneration(s, id) };
}

/** The generation that wrote this file and the ones that read it, newest first. */
export async function listGenerationsForFile(
  s: WorkspaceSession,
  fileId: string,
): Promise<{ madeBy: Generation | null; results: Generation[] }> {
  return {
    madeBy: await s.database.generations.madeBy(fileId),
    results: await s.database.generations.resultsOf(fileId, MAX_FILE_GENERATIONS),
  };
}

/**
 * Runs a failed or cancelled generation again with a new job, with its stored model, prompt and parameters.
 * The input must still be usable with the same content, and the provider entry must still exist.
 */
export async function retryGeneration(s: WorkspaceSession, deps: GenerationDeps, id: string): Promise<Generation> {
  const generation = await requireGeneration(s, id);
  const retryRefused = new InvalidOperationError('Only a failed or cancelled generation can be retried');
  if (generation.status !== 'failed' && generation.status !== 'cancelled') throw retryRefused;
  const input = generation.inputs[0];
  const file = input?.fileId == null ? null : await s.database.files.get(input.fileId);
  if (file === null || input === undefined || !isUsableInput(file) || file.sha256 !== input.sha256) {
    throw new InvalidOperationError(NOT_USABLE);
  }
  if (!deps.providers.exists(generation.providerId)) throw new ProviderNotConfiguredError('No provider is configured');
  const requeued = await s.database.generations.requeue({
    id,
    job: generationJob(s, id, file.id, generation.providerId),
    now: s.now().toISOString(),
  });
  if (!requeued) throw retryRefused;
  deps.control.wake();
  return requireGeneration(s, id);
}

/** Deletes a failed or cancelled generation; its files stay. */
export async function removeGeneration(s: WorkspaceSession, id: string): Promise<void> {
  await requireGeneration(s, id);
  if (!(await s.database.generations.remove(id))) {
    throw new InvalidOperationError('Only a failed or cancelled generation can be removed');
  }
}

/** The distinct prompts of recent edits, newest first. */
export function recentGenerationPrompts(s: WorkspaceSession): Promise<string[]> {
  return s.database.generations.recentPrompts(MAX_RECENT_PROMPTS);
}

/** Ends every pending generation whose job is gone or finished; run when a workspace opens. Answers how many. */
export function reconcileGenerations(s: WorkspaceSession): Promise<number> {
  return s.database.generations.reconcile(s.now().toISOString());
}

const baseName = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/** The file extension of each image type a result may be stored as. */
export const GENERATION_RESULT_EXTENSIONS: Readonly<Record<string, 'png' | 'jpg' | 'webp'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The names a generation stores its result under; `extension` follows the answer's image type (default PNG). */
export const generationNames = {
  edit: (sourceName: string, rank: number, extension = 'png') => `${baseName(sourceName)} edit ${rank}.${extension}`,
  upscale: (sourceName: string, scale: 2 | 4, extension = 'png') => `${baseName(sourceName)} ${scale}x.${extension}`,
};
