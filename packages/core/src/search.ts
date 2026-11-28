/** The most words a search query is cut to. */
export const MAX_SEARCH_WORDS = 16;

/**
 * A letter or digit followed by letters, digits and combining marks; everything else separates
 * words. Like the unicode61 tokenizer, marks only continue a word, so a run of marks alone is none.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/**
 * Every word of a text, NFC and lower-cased, without the cap of a search query.
 *
 * @param text any text
 * @returns its words in order
 */
export function textWords(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(WORD) ?? [];
}

/**
 * The words of a search text: NFC, lower-cased, each starting with a letter or digit, at most 16.
 *
 * @param query the search text
 * @returns its first words
 */
export function searchWords(query: string): string[] {
  return textWords(query).slice(0, MAX_SEARCH_WORDS);
}

/**
 * A word without diacritics (NFD, marks removed), lower-cased; the comparison form of the in-memory search.
 *
 * @param word one word
 * @returns its folded form
 */
export function foldSearchWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
