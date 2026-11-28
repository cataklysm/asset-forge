import {
  GENERATION_PROMPT_MAX,
  IMAGE_GENERATE_JOB,
  IMAGE_INPUT_MAX_PIXELS,
  IMAGE_INPUT_MIN_PIXELS,
  ImageGeneratePayloadSchema,
  MAX_FILE_GENERATIONS,
  MAX_RECENT_PROMPTS,
  resolvePromptText,
  UPSCALE_MAX_PIXELS,
  type FileRecord,
  type Generation,
  type GenerationParameters,
  type ImageGeneratePayload,
  type ImageModel,
  type StartGeneration,
  type StartGenerationResult,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ProviderNotConfiguredError, ValidationFailedError } from './errors.js';
import type { Job, JobControl, JobOutcome, NewJob } from './job-types.js';
import { measureFile } from './measure-file.js';
import { isPreviewable } from './media-types.js';
import type { GenerationPromptRef } from './ports/generation-repository.js';
import type { ImageProviderDirectory } from './ports/image-provider.js';
import type { WorkspaceSession } from './session.js';

/** What the generation use cases need beyond the session. */
export interface GenerationDependencies {
  /** The image provider entries and their models. */
  providers: ImageProviderDirectory;
  /** Wakes the scheduler once a job is queued. */
  control: JobControl;
}

const NOT_USABLE = 'Only a complete image outside the trash can be used';
const NOT_FOUND = 'This generation does not exist';

const RESOLVE_REFUSALS = {
  missing: 'Every variable needs a value',
  unknown: 'This prompt has no such variable',
  value_too_long: 'This text is too long',
} as const;

/** A start of an edit. */
type EditStart = Extract<StartGeneration, { kind: 'edit' }>;

/** A start of an upscale. */
type UpscaleStart = Extract<StartGeneration, { kind: 'upscale' }>;

/** The answer of a start whose provider could not list its models. */
type ModelListFailure = Extract<StartGenerationResult, { ok: false }>;

/** The source image of a start with its pixel size known. */
interface SizedInput {
  /** The source file. */
  file: FileRecord;
  /** Its width in pixels. */
  width: number;
  /** Its height in pixels. */
  height: number;
}

/** What a checked start stores on its generation. */
interface GenerationPlan {
  /** The model offered by the provider; null for an upscale. */
  model: string | null;
  /** The resolved, trimmed prompt; null for an upscale. */
  prompt: string | null;
  /** The library version the prompt came from; null for a free prompt or an upscale. */
  promptRef: GenerationPromptRef | null;
  /** The versioned parameters. */
  parameters: GenerationParameters;
}

/**
 * The text an edit sends and the library version it came from: a free prompt as it is with no reference,
 * a version with its variables filled in (the values trimmed, keyed by the version's spelling).
 *
 * @param session the open workspace
 * @param input the edit start
 * @returns the text, untrimmed, and the version reference
 * @throws `NotFoundError` for an unknown version, `ValidationFailedError` for a missing or unknown variable or a
 *   value that is too long
 */
async function editPrompt(
  session: WorkspaceSession,
  input: EditStart,
): Promise<{ text: string; promptRef: GenerationPromptRef | null }> {
  if (input.promptVersionId === undefined) return { text: input.prompt ?? '', promptRef: null };
  const found = await session.database.prompts.getVersion(input.promptVersionId);
  if (found === null) throw new NotFoundError('This prompt version does not exist');
  const { version } = found;
  const result = resolvePromptText(version.content, version.variables, input.variables ?? {});
  if (!result.ok) throw new ValidationFailedError(RESOLVE_REFUSALS[result.reason]);
  return {
    text: result.text,
    promptRef: { versionId: version.id, title: found.title, versionNumber: version.number, variables: result.values },
  };
}

/**
 * Whether a generation may read this file.
 *
 * @param file the file
 * @returns true when it is complete, outside the trash and previewable (SVG excluded)
 */
function isUsableInput(file: FileRecord): boolean {
  return file.status === 'complete' && file.deletedAt === null && isPreviewable(file.mimeType);
}

/**
 * The job that runs a generation, in the provider's lane.
 *
 * @param session the open workspace
 * @param generationId the generation
 * @param fileId the source file
 * @param providerId the provider entry, also the lane
 * @returns the new job
 */
function generationJob(session: WorkspaceSession, generationId: string, fileId: string, providerId: string): NewJob {
  const payload: ImageGeneratePayload = { v: 1, generationId };
  return {
    id: session.newId(),
    type: IMAGE_GENERATE_JOB,
    resourceClass: 'remote_api',
    fileId,
    lane: providerId,
    payload,
    dedupeKey: null,
  };
}

/**
 * A generation that must exist.
 *
 * @param session the open workspace
 * @param id the generation
 * @returns it
 * @throws `NotFoundError` when it does not exist
 */
async function requireGeneration(session: WorkspaceSession, id: string): Promise<Generation> {
  const generation = await session.database.generations.get(id);
  if (generation === null) throw new NotFoundError(NOT_FOUND);
  return generation;
}

/**
 * The source image of a start: a usable file whose pixel size, measured when unknown, lies within the provider's
 * bounds.
 *
 * @param session the open workspace
 * @param fileId the source file
 * @returns the file and its size
 * @throws `NotFoundError` for an unknown file, `InvalidOperationError` for an unusable file or size
 */
async function requireSizedInput(session: WorkspaceSession, fileId: string): Promise<SizedInput> {
  let file = await session.database.files.get(fileId);
  if (file === null) throw new NotFoundError('File not found');
  if (!isUsableInput(file)) throw new InvalidOperationError(NOT_USABLE);
  if (file.width === null || file.height === null) file = await measureFile(session, file.id);
  const { width, height } = file;
  if (
    width === null ||
    height === null ||
    width * height < IMAGE_INPUT_MIN_PIXELS ||
    width * height > IMAGE_INPUT_MAX_PIXELS
  ) {
    throw new InvalidOperationError('This image cannot be sent to the provider');
  }
  return { file, width, height };
}

/**
 * Checks an edit: the prompt (a library version is looked up and resolved here), then the model's offer, the only
 * step that asks the provider.
 *
 * @param session the open workspace
 * @param dependencies gives the provider's models
 * @param providerId the resolved provider entry
 * @param input the edit start
 * @returns what the generation stores, or the failure of the model list
 * @throws `ValidationFailedError` for a prompt, model, aspect ratio or resolution that does not fit
 */
async function planEdit(
  session: WorkspaceSession,
  dependencies: GenerationDependencies,
  providerId: string,
  input: EditStart,
): Promise<GenerationPlan | ModelListFailure> {
  const resolved = await editPrompt(session, input);
  const prompt = resolved.text.trim();
  if (prompt.length < 1 || prompt.length > GENERATION_PROMPT_MAX) {
    throw new ValidationFailedError(`The prompt must have 1 to ${GENERATION_PROMPT_MAX} characters`);
  }
  const listed = await dependencies.providers.models(providerId, new AbortController().signal);
  if (!listed.ok) return { ok: false, code: listed.code };
  const offer = listed.models.find((model) => model.name === input.model);
  if (offer === undefined) throw new ValidationFailedError('This model is not offered by the provider');
  checkOffer(offer, prompt, input);
  return {
    model: offer.name,
    prompt,
    promptRef: resolved.promptRef,
    parameters: {
      v: 1,
      aspectRatio: input.aspectRatio ?? null,
      resolution: input.resolution ?? null,
      safeMode: input.safeMode,
    },
  };
}

/**
 * Checks an edit against the model's limits: the prompt length, then the aspect ratio, then the resolution.
 *
 * @param offer the model as the provider lists it
 * @param prompt the resolved, trimmed prompt
 * @param input the edit start
 * @throws `ValidationFailedError` for the first limit that is exceeded
 */
function checkOffer(offer: ImageModel, prompt: string, input: EditStart): void {
  if (offer.promptCharacterLimit !== null && prompt.length > offer.promptCharacterLimit) {
    throw new ValidationFailedError('The prompt is longer than this model allows');
  }
  if (
    input.aspectRatio !== undefined &&
    offer.aspectRatios !== null &&
    !offer.aspectRatios.includes(input.aspectRatio)
  ) {
    throw new ValidationFailedError('This aspect ratio is not offered by the model');
  }
  if (input.resolution !== undefined && offer.resolutions !== null && !offer.resolutions.includes(input.resolution)) {
    throw new ValidationFailedError('This resolution is not offered by the model');
  }
}

/**
 * Checks an upscale: the result must stay within `UPSCALE_MAX_PIXELS`.
 *
 * @param source the source image and its size
 * @param input the upscale start
 * @returns what the generation stores
 * @throws `InvalidOperationError` when the result would be too large
 */
function planUpscale(source: SizedInput, input: UpscaleStart): GenerationPlan {
  const { width, height } = source;
  if (width * input.scale * (height * input.scale) > UPSCALE_MAX_PIXELS) {
    throw new InvalidOperationError('The upscaled image would be too large');
  }
  return { model: null, prompt: null, promptRef: null, parameters: { v: 1, scale: input.scale } };
}

/**
 * Looks the library version up again after the model list, which waits on the provider: a prompt deleted in the
 * meantime answers not_found instead of a foreign key failure. A delete between this look and the insert still
 * reaches the repository.
 *
 * @param session the open workspace
 * @param promptRef the version reference of the plan; null for a free prompt or an upscale
 * @returns nothing
 * @throws `NotFoundError` when the version no longer exists
 */
async function requireVersionStill(session: WorkspaceSession, promptRef: GenerationPromptRef | null): Promise<void> {
  if (promptRef === null) return;
  const found = await session.database.prompts.getVersion(promptRef.versionId);
  if (found === null) throw new NotFoundError('This prompt version does not exist');
}

/**
 * Starts an edit or an upscale of one image. Checks in this order: the file, its pixel size, the provider,
 * then for an edit the prompt (a library version is looked up and resolved here) and the model's offer (the
 * only step that asks the provider), for an upscale the result size. A model list that cannot be loaded is
 * answered as `{ ok: false, code }`; every other refusal throws, and nothing is queued then.
 *
 * @param session the open workspace
 * @param dependencies the provider entries and the scheduler
 * @param input the start
 * @returns the pending generation, or the failure of the model list
 */
export async function startGeneration(
  session: WorkspaceSession,
  dependencies: GenerationDependencies,
  input: StartGeneration,
): Promise<StartGenerationResult> {
  const source = await requireSizedInput(session, input.fileId);
  const entry = dependencies.providers.resolve(input.providerId);
  if (entry === null) throw new ProviderNotConfiguredError('No provider is configured');

  const plan =
    input.kind === 'edit' ? await planEdit(session, dependencies, entry.id, input) : planUpscale(source, input);
  if ('ok' in plan) return plan;
  await requireVersionStill(session, plan.promptRef);

  const { file } = source;
  const id = session.newId();
  await session.database.generations.create({
    generation: {
      id,
      kind: input.kind,
      providerId: entry.id,
      providerName: entry.name,
      providerKind: 'venice',
      model: plan.model,
      prompt: plan.prompt,
      parameters: plan.parameters,
      promptRef: plan.promptRef,
      createdAt: session.now().toISOString(),
    },
    // A complete file always has a checksum.
    input: { fileId: file.id, sha256: file.sha256!, originalName: file.originalName },
    job: generationJob(session, id, file.id, entry.id),
  });
  dependencies.providers.markUsed(entry.id);
  dependencies.control.wake();
  return { ok: true, generation: await requireGeneration(session, id) };
}

/**
 * The generation that wrote this file and the ones that read it, newest first.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the generation that made it (null when none) and at most `MAX_FILE_GENERATIONS` results
 */
export async function listGenerationsForFile(
  session: WorkspaceSession,
  fileId: string,
): Promise<{ madeBy: Generation | null; results: Generation[] }> {
  return {
    madeBy: await session.database.generations.madeBy(fileId),
    results: await session.database.generations.resultsOf(fileId, MAX_FILE_GENERATIONS),
  };
}

/**
 * Runs a failed or cancelled generation again with a new job, with its stored model, prompt and parameters.
 * The input must still be usable with the same content, and the provider entry must still exist.
 *
 * @param session the open workspace
 * @param dependencies the provider entries and the scheduler
 * @param id the generation
 * @returns the requeued generation
 * @throws `NotFoundError`, `InvalidOperationError` or `ProviderNotConfiguredError` when it cannot run again
 */
export async function retryGeneration(
  session: WorkspaceSession,
  dependencies: GenerationDependencies,
  id: string,
): Promise<Generation> {
  const generation = await requireGeneration(session, id);
  const retryRefused = new InvalidOperationError('Only a failed or cancelled generation can be retried');
  if (generation.status !== 'failed' && generation.status !== 'cancelled') throw retryRefused;
  const input = generation.inputs[0];
  const file = input?.fileId == null ? null : await session.database.files.get(input.fileId);
  if (file === null || input === undefined || !isUsableInput(file) || file.sha256 !== input.sha256) {
    throw new InvalidOperationError(NOT_USABLE);
  }
  if (!dependencies.providers.exists(generation.providerId)) {
    throw new ProviderNotConfiguredError('No provider is configured');
  }
  const requeued = await session.database.generations.requeue({
    id,
    job: generationJob(session, id, file.id, generation.providerId),
    now: session.now().toISOString(),
  });
  if (!requeued) throw retryRefused;
  dependencies.control.wake();
  return requireGeneration(session, id);
}

/**
 * Deletes a failed or cancelled generation; its files stay.
 *
 * @param session the open workspace
 * @param id the generation
 * @returns resolves once it is deleted
 * @throws `NotFoundError` for an unknown generation, `InvalidOperationError` for one in another state
 */
export async function removeGeneration(session: WorkspaceSession, id: string): Promise<void> {
  await requireGeneration(session, id);
  if (!(await session.database.generations.remove(id))) {
    throw new InvalidOperationError('Only a failed or cancelled generation can be removed');
  }
}

/**
 * The distinct prompts of recent edits, newest first.
 *
 * @param session the open workspace
 * @returns at most `MAX_RECENT_PROMPTS` prompts
 */
export function recentGenerationPrompts(session: WorkspaceSession): Promise<string[]> {
  return session.database.generations.recentPrompts(MAX_RECENT_PROMPTS);
}

/**
 * Ends every pending generation whose job is gone or finished; run when a workspace opens.
 *
 * @param session the open workspace
 * @returns how many generations were ended
 */
export function reconcileGenerations(session: WorkspaceSession): Promise<number> {
  return session.database.generations.reconcile(session.now().toISOString());
}

/**
 * Writes the outcome of an ended `image.generate` job onto its generation; synchronous, so it runs inside the
 * transaction that ends the job. Changes only a pending generation, so a late cancel never undoes a committed
 * result.
 *
 * @param session the open workspace
 * @param job the ended job
 * @param outcome how it ended
 * @returns whether a generation changed; false for every other job type
 */
export function settleGenerationOfJob(session: WorkspaceSession, job: Job, outcome: JobOutcome): boolean {
  if (job.type !== IMAGE_GENERATE_JOB) return false;
  const payload = ImageGeneratePayloadSchema.safeParse(job.payload);
  if (!payload.success) return false;
  return session.database.generations.settle({
    id: payload.data.generationId,
    outcome,
    now: session.now().toISOString(),
  });
}
