import type { Generation, ImageModel } from '@assetforge/contracts';
import type { AttachedPrompt } from './studio-prompt';

/** The edit form of the studio; null aspect ratio or resolution leaves the model's default. */
export interface StudioForm {
  providerId: string | null;
  model: string | null;
  prompt: string;
  aspectRatio: string | null;
  resolution: string | null;
  safeMode: boolean;
  /** A library prompt is in use; `prompt` is ignored while set. */
  attached: AttachedPrompt | null;
  /** The library prompt a free text was detached from. */
  origin: { promptId: string; title: string } | null;
}

/**
 * The form of a generation's "Use settings": an edit's settings with its resolved text as a free prompt
 * (the studio attaches the library prompt itself); an upscale copies nothing but the provider.
 *
 * @param generation the generation whose settings are used
 * @param form the current form, kept for an upscale
 * @returns the new form
 */
export function formFromGeneration(generation: Generation, form: StudioForm): StudioForm {
  const parameters = generation.parameters;
  if (generation.kind !== 'edit' || !('safeMode' in parameters)) return { ...form, providerId: generation.providerId };
  return {
    providerId: generation.providerId,
    model: generation.model,
    prompt: generation.prompt ?? '',
    aspectRatio: parameters.aspectRatio,
    resolution: parameters.resolution,
    safeMode: parameters.safeMode,
    attached: null,
    origin: null,
  };
}

/**
 * `form` limited to what `model` states: an aspect ratio or resolution it does not list is dropped,
 * and a dropped (or absent) resolution becomes the model's `defaultResolution` when it lists that.
 * Without a model both are dropped.
 *
 * @param form the form as chosen
 * @param model the chosen model, null when none is known
 * @returns the form as it would be sent
 */
export function constrain(form: StudioForm, model: ImageModel | null): StudioForm {
  const ratios = model?.aspectRatios ?? null;
  const resolutions = model?.resolutions ?? null;
  const fallback =
    model?.defaultResolution != null && resolutions !== null && resolutions.includes(model.defaultResolution)
      ? model.defaultResolution
      : null;
  return {
    ...form,
    aspectRatio:
      form.aspectRatio !== null && ratios !== null && ratios.includes(form.aspectRatio) ? form.aspectRatio : null,
    resolution:
      form.resolution !== null && resolutions !== null && resolutions.includes(form.resolution)
        ? form.resolution
        : fallback,
  };
}

/** The local storage key of the remembered safe mode choice. */
export const SAFE_MODE_KEY = 'assetforge.studio.safeMode';

/**
 * The remembered safe mode choice.
 *
 * @returns true unless `false` was stored or storage cannot be read
 */
export function readSafeMode(): boolean {
  try {
    return globalThis.localStorage.getItem(SAFE_MODE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Remembers the safe mode choice, best effort.
 *
 * @param isOn the choice
 */
export function writeSafeMode(isOn: boolean): void {
  try {
    globalThis.localStorage.setItem(SAFE_MODE_KEY, String(isOn));
  } catch {
    // Not remembered; the next opening starts with the default.
  }
}

/** What a result tile shows. */
export type TileState = 'queued' | 'running' | 'failed' | 'cancelled' | 'ready' | 'trashed' | 'deleted';

/**
 * What a result tile shows: a pending generation by its job, a succeeded one by its first output.
 *
 * @param generation the generation of the tile
 * @returns the tile state
 */
export function tileState(generation: Generation): TileState {
  switch (generation.status) {
    case 'pending':
      return generation.jobStatus === 'running' || generation.jobStatus === 'waiting_remote' ? 'running' : 'queued';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'succeeded': {
      const output = generation.outputs[0];
      if (output === undefined || output.fileId === null) return 'deleted';
      return output.trashed ? 'trashed' : 'ready';
    }
  }
}
