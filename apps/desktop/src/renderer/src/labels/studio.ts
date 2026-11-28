import type { GenerationParameters, GenerationStatus } from '@assetforge/contracts';
import { PROMPT_SELECT_LABEL } from './analysis';
import { JOB_STATUS_LABELS } from './jobs';
import { DELETED_LABEL } from './trash';

/** The entry points of the generation studio and the dialog's own title. */
export const GENERATE_LABEL = 'Generate from image';
export const GENERATE_TITLE = 'Edit this image with an image model';
export const UPSCALE_LABEL = 'Upscale';
export const UPSCALE_SCALE_LABELS: Record<2 | 4, string> = { 2: '2×', 4: '4×' };
export const NO_IMAGE_PROVIDER_TITLE = 'Add an image provider in Settings first';
export const UPSCALE_TITLE = 'Enlarge this image with the image provider';

/**
 * 'Upscale 4×'.
 *
 * @param scale the upscale factor
 * @returns the label of the upscale action
 */
export function upscaleLabel(scale: 2 | 4): string {
  return `${UPSCALE_LABEL} ${UPSCALE_SCALE_LABELS[scale]}`;
}
export const STUDIO_TITLE = 'Studio';

/** The form of the studio (GenerationStudio). */
export const PROMPT_LABEL = PROMPT_SELECT_LABEL;
export const RECENT_PROMPTS_LABEL = 'Recent';
export const ASPECT_LABEL = 'Aspect';
export const RESOLUTION_LABEL = 'Resolution';
export const SAFE_MODE_LABEL = 'Safe mode';
export const GENERATE_BUTTON = 'Generate';
/** The aspect (or resolution) option that leaves the model's default. */
export const MODEL_DEFAULT_OPTION = 'Default';
export const PROMPT_LENGTH_TITLE = 'The prompt must have 1 to 8000 characters';
export const PROMPT_TOO_LONG_TITLE = 'The prompt is longer than this model allows';
export const SOURCE_IMAGE_LABEL = 'Source image';
export const CLOSE_LABEL = 'Close';
export const UPSCALES_LABEL = 'Upscales';

/** The results of the studio; `RETRY_LABEL` of `common.ts` is shared. */
export const RESULTS_LABEL = 'Results';
export const USE_SETTINGS_LABEL = 'Use settings';
export const OPEN_LABEL = 'Open';
export const REMOVE_LABEL = 'Remove';
export const TRASHED_MARK = 'In the trash';
export const DELETED_MARK = DELETED_LABEL;
/** A pending generation shows its live job state as queued or running. */
export const GENERATION_STATUS_LABELS: Record<GenerationStatus | 'running', string> = {
  pending: JOB_STATUS_LABELS.queued,
  running: JOB_STATUS_LABELS.running,
  succeeded: JOB_STATUS_LABELS.succeeded,
  failed: JOB_STATUS_LABELS.failed,
  cancelled: JOB_STATUS_LABELS.cancelled,
};

/** The generation block of the file details column. */
export const GENERATED_FROM_LABEL = 'Generated from';
export const COPY_PROMPT_TITLE = 'Copy prompt';
export const PARAMETERS_LABEL = 'Parameters';
export const MODEL_LABEL = 'Model';
export const COPY_PROMPT_FAILED = 'The prompt could not be copied';
/** A source or result link whose file cannot be read. */
export const LINKED_FILE_FAILED = 'This file could not be opened';

/**
 * '16:9 · 2K · Safe mode' for an edit (a value left to the model is not named), 'Upscale 4×' for an upscale.
 *
 * @param parameters the stored parameters of a generation
 * @returns the parameters line of the generation block
 */
export function generationParametersText(parameters: GenerationParameters): string {
  if ('scale' in parameters) return upscaleLabel(parameters.scale);
  const parts = [parameters.aspectRatio, parameters.resolution, parameters.safeMode ? SAFE_MODE_LABEL : `${SAFE_MODE_LABEL} off`];
  return parts.filter((part): part is string => part !== null).join(' · ');
}
