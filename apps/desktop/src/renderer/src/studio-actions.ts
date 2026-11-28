import type { MutableRefObject } from 'react';
import { JOB_ERROR_MESSAGES, type Generation, type IpcRequest, type UpscaleScale } from '@assetforge/contracts';
import { call, messageOf } from './api';
import type { StudioSession } from './studio-context';
import type { StudioForm } from './studio-state';

/** The request of `generations:start`. */
type StartRequest = IpcRequest<'generations:start'>;

/**
 * Orders generations newest first, the higher id first at the same time.
 *
 * @param left the one generation
 * @param right the other generation
 * @returns the sort order
 */
export function newestFirst(left: Generation, right: Generation): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

/**
 * The start request of an edit: the attached library version with its values, else the free prompt.
 *
 * @param fileId the source file
 * @param providerId the image entry
 * @param model the model
 * @param form the form as it would be sent
 * @returns the request
 */
export function editRequestOf(fileId: string, providerId: string, model: string, form: StudioForm): StartRequest {
  return {
    kind: 'edit',
    fileId,
    providerId,
    model,
    ...(form.attached !== null
      ? { promptVersionId: form.attached.version.id, variables: form.attached.values }
      : { prompt: form.prompt }),
    ...(form.aspectRatio !== null ? { aspectRatio: form.aspectRatio } : {}),
    ...(form.resolution !== null ? { resolution: form.resolution } : {}),
    safeMode: form.safeMode,
  };
}

/** What an edit start works with. */
export interface EditStart {
  session: StudioSession;
  fileId: string;
  /** True once the studio unmounted. */
  disposed: MutableRefObject<boolean>;
  setStarting(starting: boolean): void;
  setStartError(message: string | null): void;
  /** Makes the jobs context poll at once. */
  refresh(): void;
  /** After an accepted start while this studio is mounted. */
  onStarted(): void;
}

/**
 * Sends the edit start; a refusal is the start error.
 *
 * @param start the context
 * @param request the request
 * @returns resolves once answered; rejects with a failed call
 */
async function sendEdit(start: EditStart, request: StartRequest): Promise<void> {
  const result = await call('generations:start', request);
  // A studio mounted anew meanwhile reads its results when the jobs poll and shows the error.
  if (result.ok) start.refresh();
  else start.setStartError(JOB_ERROR_MESSAGES[result.code]);
  if (start.disposed.current) return;
  if (result.ok) start.onStarted();
}

/**
 * Starts an edit through the session's guard, so a raise never sends it twice.
 *
 * @param start the context
 * @param request the request
 * @returns resolves once done; never rejects
 */
export async function startEdit(start: EditStart, request: StartRequest): Promise<void> {
  start.setStarting(true);
  start.setStartError(null);
  try {
    await start.session.guardStart(start.fileId, 'edit', () => sendEdit(start, request));
  } catch (error) {
    start.setStartError(messageOf(error));
  } finally {
    if (!start.disposed.current) start.setStarting(false);
  }
}

/** What one result action works with. */
export interface ActionRun {
  busy: boolean;
  setBusy(busy: boolean): void;
  setActionError(message: string | null): void;
  /** True once the studio unmounted. */
  disposed: MutableRefObject<boolean>;
}

/**
 * Runs one result action; its failure is shown above the results.
 *
 * @param run the context
 * @param action the action
 * @returns resolves once done; never rejects; nothing runs while another action does
 */
export async function runAction(run: ActionRun, action: () => Promise<void>): Promise<void> {
  if (run.busy) return;
  run.setBusy(true);
  run.setActionError(null);
  try {
    await action();
  } catch (error) {
    if (!run.disposed.current) run.setActionError(messageOf(error));
  } finally {
    if (!run.disposed.current) run.setBusy(false);
  }
}

/** What the result actions work with. */
export interface ResultContext {
  session: StudioSession;
  /** True once the studio unmounted. */
  disposed: MutableRefObject<boolean>;
  setActionError(message: string | null): void;
  /** Makes the jobs context poll at once. */
  refresh(): void;
  /** The jobs poll at once and the results are read again. */
  changed(): void;
}

/**
 * Sends the upscale start; a refusal is the action error.
 *
 * @param context the context
 * @param request the request
 * @returns resolves once answered; rejects with a failed call
 */
async function sendUpscale(context: ResultContext, request: StartRequest): Promise<void> {
  const result = await call('generations:start', request);
  if (result.ok) context.refresh();
  if (context.disposed.current) return;
  if (!result.ok) context.setActionError(JOB_ERROR_MESSAGES[result.code]);
  else context.changed();
}

/**
 * Upscales a result (or the source) through the session's guard.
 *
 * @param context the context
 * @param providerId the image entry; null does nothing
 * @param fileId the file
 * @param scale the scale
 * @returns resolves once done; rejects with a failed call
 */
export async function upscaleFile(
  context: ResultContext,
  providerId: string | null,
  fileId: string,
  scale: UpscaleScale,
): Promise<void> {
  if (providerId === null) return;
  await context.session.guardStart(fileId, 'upscale', () =>
    sendUpscale(context, { kind: 'upscale', fileId, providerId, scale }),
  );
}

/**
 * Starts a failed or cancelled generation again.
 *
 * @param context the context
 * @param generation the generation
 * @returns resolves once done; rejects with a failed call
 */
export async function retryGeneration(context: ResultContext, generation: Generation): Promise<void> {
  await call('generations:retry', { generationId: generation.id });
  if (!context.disposed.current) context.changed();
}

/**
 * Removes a failed or cancelled generation.
 *
 * @param context the context
 * @param generation the generation
 * @returns resolves once done; rejects with a failed call
 */
export async function removeGeneration(context: ResultContext, generation: Generation): Promise<void> {
  await call('generations:remove', { generationId: generation.id });
  if (!context.disposed.current) context.changed();
}

/**
 * Moves a result file to the trash; the selection goes when it was the selected result.
 *
 * @param context the context
 * @param fileId the file
 * @param selectedFileId the file of the selected result; null for none
 * @param clearSelection drops the selection
 * @returns resolves once done; rejects with a failed call
 */
export async function trashResult(
  context: ResultContext,
  fileId: string,
  selectedFileId: string | null,
  clearSelection: () => void,
): Promise<void> {
  const answer = await call('files:trashMany', { fileIds: [fileId] });
  if (context.disposed.current) return;
  const error = answer.items.find((item) => item.error !== null)?.error ?? null;
  if (error !== null) context.setActionError(error.message);
  else if (fileId === selectedFileId) clearSelection();
  context.changed();
}
