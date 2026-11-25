import { foldSearchWord, textWords } from '@assetforge/core';
import type Database from 'better-sqlite3';

/**
 * Registers the deterministic text functions the list filters use, so SQLite folds exactly like
 * the in-memory search of core:
 * - `af_fold(text)`: the text without diacritics, lower-cased (`foldSearchWord`); null stays null.
 * - `af_word_prefix(text, prefix)`: 1 when a folded word of the text starts with `prefix`, else 0.
 */
export function registerSqlFunctions(sqlite: Database.Database): void {
  sqlite.function('af_fold', { deterministic: true }, (text: unknown) =>
    typeof text === 'string' ? foldSearchWord(text) : null,
  );
  sqlite.function('af_word_prefix', { deterministic: true }, (text: unknown, prefix: unknown) =>
    typeof text === 'string' &&
    typeof prefix === 'string' &&
    textWords(text).some((word) => foldSearchWord(word).startsWith(prefix))
      ? 1
      : 0,
  );
}
