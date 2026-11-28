import { ANALYSIS_TAG_LIMIT_MAX, ANALYSIS_TAG_LIMIT_MIN, type AnalysisPromptPurpose } from '@assetforge/contracts';

/** The Prompts section of the settings (PromptSettings). */
export const PROMPTS_TITLE = 'Analysis prompts';
export const PROMPT_PURPOSE_LABELS: Record<AnalysisPromptPurpose, string> = {
  tagging: 'Tagging',
  image_prompt: 'Image to prompt',
};
export const PROMPT_PURPOSE_TITLES: Record<AnalysisPromptPurpose, string> = {
  tagging: 'Prompts the tag analysis can send with an image',
  image_prompt: 'Prompts Image to prompt can send with an image',
};
export const PROMPTS_LOAD_FAILED = 'The analysis prompts could not be read';
/** The retry beside the prompt select of the analysis dialogs after a failed load. */
export const RELOAD_PROMPTS_LABEL = 'Read the analysis prompts again';
export const ANALYSIS_NEW_PROMPT_LABEL = 'New';
export const NEW_PROMPT_TITLE = 'Adds a prompt with the built-in text';
/** The name of a new prompt: 'New prompt', then 'New prompt 2', … */
export const NEW_PROMPT_NAME = 'New prompt';
export const PROMPT_NAME_LABEL = 'Name';
export const PROMPT_NAME_TITLE = 'Shown in the analysis dialogs; unique within its list';
export const PROMPT_TAG_LIMIT_LABEL = 'Tag limit';
export const PROMPT_TAG_LIMIT_TITLE = `At most this many tags are kept from one answer (${ANALYSIS_TAG_LIMIT_MIN}–${ANALYSIS_TAG_LIMIT_MAX})`;
export const ANALYSIS_PROMPT_TEXT_LABEL = 'Text';
export const ANALYSIS_PROMPT_TEXT_TITLE = 'Sent to the vision model together with the image';
export const RESET_LABEL = 'Reset';
export const RESET_PROMPT_TITLE = 'Replaces the text with the built-in one; the name stays';
export const ANALYSIS_DELETE_PROMPT_TITLE = 'Deletes the prompt; asks first';
export const LAST_PROMPT_TITLE = 'The last prompt cannot be deleted';
export const UNSAVED_CHANGES = 'Unsaved changes';
export const NO_CHANGES = 'No unsaved changes';
export const ENTER_NAME = 'Enter a name';
export const ENTER_TEXT = 'Enter a text';
export const TAG_LIMIT_INVALID = `The tag limit must be a whole number from ${ANALYSIS_TAG_LIMIT_MIN} to ${ANALYSIS_TAG_LIMIT_MAX}`;

/**
 * 'Delete the prompt Detailed?'.
 *
 * @param name the analysis prompt's name
 * @returns the title of the delete confirmation
 */
export function deletePromptTitle(name: string): string {
  return `Delete the prompt ${name}?`;
}
