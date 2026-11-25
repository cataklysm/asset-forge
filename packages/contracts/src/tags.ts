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

export const TagSuggestionSchema = z.object({ name: z.string(), displayName: z.string() });
export type TagSuggestion = z.infer<typeof TagSuggestionSchema>;

/** Trimmed, whitespace-collapsed and NFC-normalised; case is kept. */
export function cleanTagText(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Clean text, lower-cased and NFC again (lower-casing can produce a composable sequence). */
const lowerTagText = (input: string) => cleanTagText(input).toLowerCase().normalize('NFC');

/** The tag key: clean text, lower-cased, NFC. Null when empty or longer than 64 code points. */
export function normalizeTagName(input: string): string | null {
  const name = lowerTagText(input);
  if (name === '') return null;
  return [...name].length > MAX_TAG_LENGTH ? null : name;
}

/** A suggestion prefix, normalised like a tag name but without the length limit; may be empty. */
export function normalizeTagPrefix(input: string): string {
  return lowerTagText(input);
}
