import {
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPrompt,
  type AnalysisPromptPurpose,
  type SaveAnalysisPrompt,
} from '@assetforge/contracts';
import { ENTER_NAME, ENTER_TEXT, NEW_PROMPT_NAME, TAG_LIMIT_INVALID } from './labels';

/** The editable fields of one analysis prompt, as typed. `maxTags` is unused for Image to prompt. */
export interface AnalysisPromptDraft {
  name: string;
  text: string;
  maxTags: string;
}

/**
 * The draft of a stored prompt.
 *
 * @param prompt the prompt
 * @returns the draft
 */
export const draftOf = (prompt: AnalysisPrompt): AnalysisPromptDraft => ({
  name: prompt.name,
  text: prompt.text,
  maxTags: prompt.purpose === 'tagging' ? String(prompt.maxTags) : '',
});

/**
 * The tag limit.
 *
 * @param text the typed text
 * @returns the limit, or null when it is not a whole number in range
 */
export function tagLimitOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= ANALYSIS_TAG_LIMIT_MIN && value <= ANALYSIS_TAG_LIMIT_MAX ? value : null;
}

/**
 * Whether saving `draft` would change `prompt` (values compared as they would be sent).
 *
 * @param prompt the stored prompt
 * @param draft the draft; undefined when none is kept
 * @returns true when it would change
 */
export function changed(prompt: AnalysisPrompt, draft: AnalysisPromptDraft | undefined): boolean {
  if (draft === undefined) return false;
  if (draft.name.trim() !== prompt.name || draft.text.trim() !== prompt.text) return true;
  if (prompt.purpose !== 'tagging') return false;
  // A limit typed with leading zeros is sent as its number; anything else that is not one counts as changed.
  const limit = tagLimitOf(draft.maxTags);
  return limit === null ? draft.maxTags.trim() !== String(prompt.maxTags) : limit !== prompt.maxTags;
}

/**
 * Why the draft cannot be saved.
 *
 * @param prompt the stored prompt
 * @param draft the draft
 * @returns the reason, or null when it can be saved
 */
export function invalidReason(prompt: AnalysisPrompt, draft: AnalysisPromptDraft): string | null {
  if (draft.name.trim() === '') return ENTER_NAME;
  if (draft.text.trim() === '') return ENTER_TEXT;
  if (prompt.purpose === 'tagging' && tagLimitOf(draft.maxTags) === null) return TAG_LIMIT_INVALID;
  return null;
}

/**
 * The first of 'New prompt', 'New prompt 2', … that no prompt of the purpose carries (ignoring case).
 *
 * @param prompts the prompts
 * @param purpose the purpose
 * @returns the free name
 */
export function freeName(prompts: readonly AnalysisPrompt[], purpose: AnalysisPromptPurpose): string {
  const own = prompts.filter((prompt) => prompt.purpose === purpose);
  const taken = new Set(own.map((prompt) => prompt.name.trim().toLowerCase()));
  for (let number = 1; ; number += 1) {
    const name = number === 1 ? NEW_PROMPT_NAME : `${NEW_PROMPT_NAME} ${number}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * The save request of a valid draft of a stored prompt.
 *
 * @param prompt the stored prompt
 * @param draft the draft, valid
 * @returns the request
 */
export function saveInputOf(prompt: AnalysisPrompt, draft: AnalysisPromptDraft): SaveAnalysisPrompt {
  const name = draft.name.trim();
  const text = draft.text.trim();
  return prompt.purpose === 'tagging'
    ? { id: prompt.id, purpose: 'tagging', name, text, maxTags: tagLimitOf(draft.maxTags)! }
    : { id: prompt.id, purpose: 'image_prompt', name, text };
}

/**
 * The request that creates a copy of `first` under `name`.
 *
 * @param first the first prompt of the purpose
 * @param name the free name
 * @returns the request
 */
export function copyInputOf(first: AnalysisPrompt, name: string): SaveAnalysisPrompt {
  return first.purpose === 'tagging'
    ? { purpose: 'tagging', name, text: first.text, maxTags: first.maxTags }
    : { purpose: 'image_prompt', name, text: first.text };
}

/**
 * The drafts without the one of `id`; with `only` given, only while that very draft is kept.
 *
 * @param drafts the kept drafts
 * @param id the prompt
 * @param only the draft that may be dropped; undefined drops any
 * @returns the new drafts, or `drafts` itself when nothing was dropped
 */
export function withoutDraft(
  drafts: Record<string, AnalysisPromptDraft>,
  id: string,
  only?: AnalysisPromptDraft,
): Record<string, AnalysisPromptDraft> {
  if (!(id in drafts) || (only !== undefined && drafts[id] !== only)) return drafts;
  const rest = { ...drafts };
  delete rest[id];
  return rest;
}
