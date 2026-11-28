import { formatDateTime } from '../format';
import { promptCount } from './counts';

/** The prompt library (Prompts screen); the analysis prompts of the settings keep their own labels. */
export const PROMPTS_LABEL = 'Prompts';
export const NEW_PROMPT_LABEL = 'New';
export const PROMPT_TITLE_LABEL = 'Title';
export const PROMPT_DESCRIPTION_LABEL = 'Description';
export const PROMPT_TEXT_LABEL = 'Text';
export const PROMPT_TEXT_TITLE = 'Write {{name}} for a part that changes';
export const PROMPT_VERSION_LABEL = 'Version';
export const USE_VERSION_LABEL = 'Use this version';
export const UNSAVED_PROMPT_TITLE = 'Discard the unsaved changes?';
export const DISCARD_LABEL = 'Discard';
export const DELETE_PROMPT_TITLE = 'Delete this prompt?';
export const SEARCH_PROMPTS_LABEL = 'Search prompts';
export const PROMPT_TAG_FILTER_TITLE = 'Prompts that carry all these tags';
export const PROMPT_TAGS_LABEL = 'Prompt tags';
export const NO_PROMPTS_TEXT = 'No prompts';
export const NO_MATCHING_PROMPTS_TEXT = 'No matching prompts';
export const NO_PROMPT_SELECTED_TEXT = 'No prompt selected';

/**
 * 'v3 · <date and time as the lists format them>'.
 *
 * @param number the version number
 * @param createdAt the version's ISO creation time
 * @returns the entry of the version select
 */
export function promptVersionLabel(number: number, createdAt: string): string {
  return `v${number} · ${formatDateTime(createdAt)}`;
}

/**
 * '1 prompt' / '12 prompts'.
 *
 * @param count the number of prompts
 * @returns the count text
 */
export function promptCountLabel(count: number): string {
  return promptCount(count);
}

/** Library prompts in the studio form (StudioForm, PromptPicker, SavePromptDialog). */
export const LIBRARY_PROMPT_LABEL = 'Library';
export const LIBRARY_PROMPT_TITLE = 'Choose a prompt from the library';
export const EDIT_PROMPT_TEXT_LABEL = 'Edit text';
export const EDIT_PROMPT_TEXT_TITLE = 'Use the text as a free prompt';
export const SAVE_TO_LIBRARY_LABEL = 'Save to library';
export const VARIABLE_MISSING_TITLE = 'Fill in every variable';
/** The reason Generate is blocked when a library prompt variable holds a value over its limit. */
export const VARIABLE_TOO_LONG_TITLE = 'A variable value is too long';
export const NEWER_VERSION_TITLE = 'A newer version exists; click to load it';
export const NEW_LIBRARY_PROMPT_LABEL = 'New prompt';

/**
 * 'Hero shot v3'.
 *
 * @param title the prompt's title
 * @param number the version number
 * @returns the name of an attached library prompt
 */
export function attachedPromptLabel(title: string, number: number): string {
  return `${title} v${number}`;
}

/** The accessible name of the attached prompt in the studio form. */
export const ATTACHED_PROMPT_LABEL = 'Library prompt';

/**
 * One 'name: value' per line, as the tooltip of an attached prompt; empty for no values.
 *
 * @param values the variable values, or null for none
 * @returns the tooltip text
 */
export function promptValuesTitle(values: Readonly<Record<string, string>> | null): string {
  return Object.entries(values ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/**
 * 'New version of Hero shot'.
 *
 * @param title the title of the prompt the version is saved to
 * @returns the option of the save dialog
 */
export function newVersionOfLabel(title: string): string {
  return `New version of ${title}`;
}
