// The texts of the tag chips, tag lists, editable tag rows and the tag filter; prompt tags use `PROMPT_TAGS_LABEL`.

/** The tooltip of an AI tag chip. */
export const AI_TAG_TITLE = 'AI tag';
/** The name of a list or row of asset tags. */
export const ASSET_TAGS_LABEL = 'Asset tags';
/** The name of the image icon before file tags. */
export const IMAGE_TAGS_LABEL = 'Image tags';
/** The placeholder of the add input of a tag row. */
export const ADD_TAG_PLACEHOLDER = '+ Add tag';
/** The accessible name of the add input of asset tags. */
export const ADD_ASSET_TAG_LABEL = 'Add asset tag';
/** The accessible name of the add input of prompt tags. */
export const ADD_PROMPT_TAG_LABEL = 'Add prompt tag';
/** The accessible name of the add input of image tags. */
export const ADD_IMAGE_TAG_LABEL = 'Add image tag';
/** Shown when the typed tag fails the name rule. */
export const INVALID_TAG = 'Tags need a letter or digit and at most 64 characters.';
/** The placeholder and accessible name of the tag filter input. */
export const TAG_FILTER_LABEL = 'Tags';

/**
 * The accessible name of a chip's remove button: 'Remove AI tag front' or 'Remove front'.
 *
 * @param displayName the tag's display name
 * @param ai whether the chip shows an AI tag
 * @returns the name
 */
export function removeTagLabel(displayName: string, ai: boolean): string {
  return ai ? `Remove AI tag ${displayName}` : `Remove ${displayName}`;
}

/**
 * The tooltip of a full tag filter: 'At most 10 tags'.
 *
 * @param max the most names the filter takes
 * @returns the tooltip
 */
export function tagFilterFullTitle(max: number): string {
  return `At most ${max} tags`;
}
