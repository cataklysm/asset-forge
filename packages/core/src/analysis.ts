import { cleanTagText, normalizeTagName, type FileRecord } from '@assetforge/contracts';
import { isPreviewable } from './media-types.js';

export const ANALYSIS_PROMPT_VERSION = 1;

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

export const MAX_ANALYSIS_TAGS = 20;

/** The Image2Prompt request: one paragraph that describes the image well enough to recreate it. */
export const IMAGE_PROMPT =
  'Describe this image in one English paragraph, precisely enough that an artist or an image model could recreate it: ' +
  'the subject, its shape and details, the materials, the colours, the lighting, the view or camera angle and the visual style. ' +
  'Answer only with that paragraph, without a preamble, a title or a list.';

/** Longest Image2Prompt text handed back; longer answers are cut. */
export const MAX_PROMPT_TEXT = 4000;

/**
 * The usable tags of a provider answer, in order, distinct by normalised name, at most 20; [] when
 * the answer has no usable tag. The answer is untrusted: anything but an object with a `tags` array
 * yields []; entries that are not strings or not valid tags are dropped.
 */
export function cleanAnalysisTags(answer: unknown): { name: string; displayName: string }[] {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return [];
  const entries: unknown = (answer as { tags?: unknown }).tags;
  if (!Array.isArray(entries)) return [];
  const result: { name: string; displayName: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (result.length === MAX_ANALYSIS_TAGS) break;
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
