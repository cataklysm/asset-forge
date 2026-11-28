import { GENERATION_PROMPT_MAX, purposeOf, type ImageModel } from '@assetforge/contracts';
import { NO_IMAGE_PROVIDER_TITLE, PROMPT_LENGTH_TITLE, PROMPT_TOO_LONG_TITLE, VARIABLE_MISSING_TITLE } from './labels';
import type { ProvidersState } from './provider-context';
import { imageProviderGate } from './provider-gate';
import { preview } from './studio-prompt';
import type { StudioForm } from './studio-state';

/**
 * The listed model of the selected image entry.
 *
 * @param providers the provider context
 * @param providerId the selected entry; null for none
 * @param model the selected model; null for none
 * @returns the model, or null while it is not listed (or the list is not there)
 */
export function imageModelOf(
  providers: Pick<ProvidersState, 'imageModels'>,
  providerId: string | null,
  model: string | null,
): ImageModel | null {
  const imageModels = providerId === null ? undefined : providers.imageModels[providerId];
  if (imageModels === undefined || imageModels === 'checking' || !imageModels.ok) return null;
  return imageModels.models.find((listed) => listed.name === model) ?? null;
}

/**
 * Whether any image entry exists.
 *
 * @param providers the provider context
 * @returns true when one does
 */
export function hasImageProvider(providers: Pick<ProvidersState, 'list'>): boolean {
  return providers.list?.providers.some((entry) => purposeOf(entry.kind) === 'image') ?? false;
}

/**
 * Why the prompt keeps Generate disabled.
 *
 * @param form the form
 * @param imageModel the listed model; null when unknown
 * @returns the reason, or null when the prompt can be sent
 */
function promptBlocked(form: StudioForm, imageModel: ImageModel | null): string | null {
  const limit = Math.min(imageModel?.promptCharacterLimit ?? GENERATION_PROMPT_MAX, GENERATION_PROMPT_MAX);
  const shown = form.attached === null ? null : preview(form.attached);
  if (shown?.blocked != null) return VARIABLE_MISSING_TITLE;
  const promptLength = (shown?.text ?? form.prompt).trim().length;
  if (promptLength < 1 || promptLength > GENERATION_PROMPT_MAX) return PROMPT_LENGTH_TITLE;
  return promptLength > limit ? PROMPT_TOO_LONG_TITLE : null;
}

/**
 * Why Generate is disabled: the provider first, then the prompt.
 *
 * @param providers the provider context
 * @param form the form, with the selected entry and model
 * @param imageModel the listed model; null when unknown
 * @returns the reason, or null when an edit can start
 */
export function editBlocked(providers: ProvidersState, form: StudioForm, imageModel: ImageModel | null): string | null {
  const providerBlocked =
    providers.list !== null && !hasImageProvider(providers)
      ? NO_IMAGE_PROVIDER_TITLE
      : imageProviderGate(providers, form.providerId, form.model).blocked;
  return providerBlocked ?? promptBlocked(form, imageModel);
}
