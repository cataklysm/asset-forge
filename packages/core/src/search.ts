export const MAX_SEARCH_WORDS = 16;

/** Runs of letters, digits and combining marks; everything else separates words. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** The words of a search text: NFC, lower-cased, split at everything but letters, digits and marks, at most 16. */
export function searchWords(query: string): string[] {
  const words = query.normalize('NFC').toLowerCase().match(WORD) ?? [];
  return words.slice(0, MAX_SEARCH_WORDS);
}

/** A word without diacritics (NFD, marks removed), lower-cased; the comparison form of the in-memory search. */
export function foldSearchWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
