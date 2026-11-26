import {
  ANALYSIS_TAG_LIMIT_DEFAULT,
  ANALYSIS_TAG_LIMIT_MAX,
  cleanTagText,
  normalizeTagName,
  type AnalysisPromptPurpose,
  type FileRecord,
} from '@assetforge/contracts';
import { isPreviewable } from './media-types.js';

export const ANALYSIS_PROMPT_VERSION = 1;

/** Sent verbatim by v1 and v2 jobs. Unchanged text. */
export const ANALYSIS_PROMPT = [
  'Describe this image with 8 to 15 short tags in English, all in lower case.',
  'Cover what is shown, the materials and the dominant colours.',
  'Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".',
  'Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".',
  'Answer only with JSON of the form {"tags": ["...", "..."]}.',
].join('\n');

/** JSON schema of the answer, passed to the provider as its output format. */
export const ANALYSIS_SCHEMA: unknown = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
  additionalProperties: false,
};

/** The tag cut of v1 and v2 jobs, which run with `ANALYSIS_PROMPT`. */
export const LEGACY_TAG_LIMIT = 20;

/** The upper bound of an analysis prompt's `maxTags`. */
export const MAX_ANALYSIS_TAGS = ANALYSIS_TAG_LIMIT_MAX;

/** The fixed last line of every tagging request; it matches `ANALYSIS_SCHEMA`. */
export const ANALYSIS_FORMAT_LINE = 'Answer only with JSON of the form {"tags": ["...", "..."]}.';

const BUILT_IN_TAGGING_TEXT = [
  'Describe this image with short tags in English, all in lower case.',
  'Cover what is shown, the materials and the dominant colours.',
  'Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".',
  'Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".',
].join('\n');

/** The Image2Prompt request: one paragraph that describes the image well enough to recreate it. */
export const IMAGE_PROMPT =
  'Describe this image in one English paragraph, precisely enough that an artist or an image model could recreate it: ' +
  'the subject, its shape and details, the materials, the colours, the lighting, the view or camera angle and the visual style. ' +
  'Answer only with that paragraph, without a preamble, a title or a list.';

/** Longest Image2Prompt text handed back; longer answers are cut. */
export const MAX_PROMPT_TEXT = 4000;

/** The built-in content of a purpose: seed and reset target. `maxTags` is null for `image_prompt`. */
export function builtInAnalysisPrompt(purpose: AnalysisPromptPurpose): { text: string; maxTags: number | null } {
  return purpose === 'tagging'
    ? { text: BUILT_IN_TAGGING_TEXT, maxTags: ANALYSIS_TAG_LIMIT_DEFAULT }
    : { text: IMAGE_PROMPT, maxTags: null };
}

/** The request of a v3 tagging job: the owner's text, the limit line and the fixed format line. */
export function composeTaggingRequest(p: { text: string; maxTags: number }): string {
  return `${p.text}\nGive at most ${p.maxTags} tags.\n${ANALYSIS_FORMAT_LINE}`;
}

/**
 * The usable tags of a provider answer, in order, distinct by normalised name, at most `limit`; []
 * when the answer has no usable tag. The answer is untrusted: anything but an object with a `tags`
 * array yields []; entries that are not strings or not valid tags are dropped before counting.
 */
export function cleanAnalysisTags(answer: unknown, limit: number): { name: string; displayName: string }[] {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return [];
  const entries: unknown = (answer as { tags?: unknown }).tags;
  if (!Array.isArray(entries)) return [];
  const result: { name: string; displayName: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (result.length >= limit) break;
    if (typeof entry !== 'string') continue;
    const name = normalizeTagName(entry);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, displayName: cleanTagText(entry) });
  }
  return result;
}

/** Complete, not in the trash, of a previewable MIME type and with a checksum. */
export function isAnalysable(file: FileRecord): boolean {
  return (
    file.status === 'complete' && file.deletedAt === null && isPreviewable(file.mimeType) && file.sha256 !== null
  );
}
