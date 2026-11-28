import { z } from 'zod';

/** Longest tag name, in code points. */
export const MAX_TAG_LENGTH = 64;

/** Where a tag came from: typed by the user or applied by the analysis. */
export const TagOriginSchema = z.enum(['manual', 'ai']);
/** Where a tag came from. */
export type TagOrigin = z.infer<typeof TagOriginSchema>;

/** A tag on one owner. `name` is the normalised key, `displayName` the spelling it was first created with. */
export const TagAssignmentSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  origin: TagOriginSchema,
});
/** A tag on one owner. */
export type TagAssignment = z.infer<typeof TagAssignmentSchema>;

/**
 * Where a requested filter tag was found on a list item: on the asset itself, on one of its complete files, or
 * both.
 */
export const MatchedTagSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  onAsset: z.boolean(),
  onFiles: z.boolean(),
});
/** Where a requested filter tag was found on a list item. */
export type MatchedTag = z.infer<typeof MatchedTagSchema>;

/** An existing tag offered while typing: the normalised key and its display spelling. */
export const TagSuggestionSchema = z.object({ name: z.string(), displayName: z.string() });
/** An existing tag offered while typing. */
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
  prompts: z.number().int().min(0),
});
/** The answer of `tags:usage`. */
export type TagUsage = z.infer<typeof TagUsageSchema>;

/** The tag a rename kept; `merged` is true when it was merged into an existing tag. */
export const TagRenameResultSchema = z.object({ name: z.string(), displayName: z.string(), merged: z.boolean() });
/** The answer of `tags:rename`. */
export type TagRenameResult = z.infer<typeof TagRenameResultSchema>;

/**
 * Trimmed, whitespace-collapsed and NFC-normalised; case is kept.
 *
 * @param input the typed tag text
 * @returns the cleaned text, possibly empty
 */
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
 *
 * @param input the typed tag text
 * @returns the normalised key, or null when the text is not a valid tag name
 */
export function normalizeTagName(input: string): string | null {
  const name = lowerTagText(input);
  if (!LETTER_OR_DIGIT.test(name)) return null;
  return [...name].length > MAX_TAG_LENGTH ? null : name;
}

/**
 * A suggestion prefix, normalised like a tag name but without the length limit; may be empty.
 *
 * @param input the typed prefix
 * @returns the normalised prefix
 */
export function normalizeTagPrefix(input: string): string {
  return lowerTagText(input);
}
