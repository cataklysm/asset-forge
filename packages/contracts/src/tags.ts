import { z } from 'zod';

export const MAX_TAG_LENGTH = 64;

export const TagOriginSchema = z.enum(['manual', 'ai']);
export type TagOrigin = z.infer<typeof TagOriginSchema>;

/** A tag on one owner. `name` is the normalised key, `displayName` the spelling it was first created with. */
export const TagAssignmentSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  origin: TagOriginSchema,
});
export type TagAssignment = z.infer<typeof TagAssignmentSchema>;

/** Where a requested filter tag was found on a list item: on the asset itself, on one of its complete files, or both. */
export const MatchedTagSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  onAsset: z.boolean(),
  onFiles: z.boolean(),
});
export type MatchedTag = z.infer<typeof MatchedTagSchema>;

export const TagSuggestionSchema = z.object({ name: z.string(), displayName: z.string() });
export type TagSuggestion = z.infer<typeof TagSuggestionSchema>;

/** How much one tag name touches: assets carrying it themselves and files not in the trash carrying it. */
export const TagUsageSchema = z.object({
  exists: z.boolean(),
  /** Normalised; '' when the text is not a valid tag name. */
  name: z.string(),
  /** '' when the tag does not exist. */
  displayName: z.string(),
  assets: z.number().int().min(0),
  files: z.number().int().min(0),
});
export type TagUsage = z.infer<typeof TagUsageSchema>;

export const TagRenameResultSchema = z.object({ name: z.string(), displayName: z.string(), merged: z.boolean() });
export type TagRenameResult = z.infer<typeof TagRenameResultSchema>;

/** Trimmed, whitespace-collapsed and NFC-normalised; case is kept. */
export function cleanTagText(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Clean text, lower-cased and NFC again (lower-casing can produce a composable sequence). */
const lowerTagText = (input: string) => cleanTagText(input).toLowerCase().normalize('NFC');

/** A tag needs a letter or digit: a symbol-only tag has no search token. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The tag key: clean text, lower-cased, NFC. Null when it has no letter or digit (which includes
 * empty text) or is longer than 64 code points.
 */
export function normalizeTagName(input: string): string | null {
  const name = lowerTagText(input);
  if (!LETTER_OR_DIGIT.test(name)) return null;
  return [...name].length > MAX_TAG_LENGTH ? null : name;
}

/** A suggestion prefix, normalised like a tag name but without the length limit; may be empty. */
export function normalizeTagPrefix(input: string): string {
  return lowerTagText(input);
}
