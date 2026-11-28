import { foldSearchWord, textWords } from '@assetforge/core';
import type Database from 'better-sqlite3';

/**
 * Registers the deterministic text functions the list filters use, so SQLite folds exactly like
 * the in-memory search of core:
 * - `af_fold(text)`: the text without diacritics, lower-cased (`foldSearchWord`); null stays null.
 * - `af_word_prefix(text, prefix)`: 1 when a folded word of the text starts with `prefix`, else 0.
 *
 * @param sqlite the connection
 * @returns nothing
 */
export function registerSqlFunctions(sqlite: Database.Database): void {
  sqlite.function('af_fold', { deterministic: true }, foldColumn);
  sqlite.function('af_word_prefix', { deterministic: true }, hasWordPrefix);
}

/**
 * `af_fold`: the folded text.
 *
 * @param text the column value
 * @returns the folded text; null for anything but a string
 */
function foldColumn(text: unknown): string | null {
  return typeof text === 'string' ? foldSearchWord(text) : null;
}

/**
 * `af_word_prefix`: whether a folded word of the text starts with the prefix.
 *
 * @param text the column value
 * @param prefix the folded prefix
 * @returns 1 when one does, else 0
 */
function hasWordPrefix(text: unknown, prefix: unknown): number {
  return typeof text === 'string' &&
    typeof prefix === 'string' &&
    textWords(text).some((word) => foldSearchWord(word).startsWith(prefix))
    ? 1
    : 0;
}
