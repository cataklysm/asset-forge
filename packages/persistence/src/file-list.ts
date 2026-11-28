import type { FileScope } from '@assetforge/contracts';
import { foldSearchWord, searchWords, type FileQuery } from '@assetforge/core';
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { file, fileAnalysisProposal, fileTag, tag } from './schema.js';

// The statements of a file list: the condition of its filters, the page and the count.

/** A handle that can read: the database or a transaction on it. */
type ListTransaction = Pick<BetterSQLite3Database, 'select'>;

/** The filters of a file list without the page. */
type FileListFilter = Omit<FileQuery, 'limit' | 'offset'>;

/**
 * Not in the trash. The unary `+` keeps `file_deleted_at_idx` out of the plan: nearly every row is
 * live, and without statistics SQLite would otherwise prefer it to the scope's `asset_id` key.
 *
 * @returns the condition
 */
export const live = () => sql`+${qualified(file, file.deletedAt)} is null`;

/**
 * In the trash. `unlikely` tells the planner that few rows are, so `file_deleted_at_idx` drives the
 * trash list even under expensive filters (it would otherwise scan `file`).
 *
 * @returns the condition
 */
export const trashed = () => sql`unlikely(${qualified(file, file.deletedAt)} is not null)`;

/**
 * The scope condition. A trashed file has no asset (the repositories keep that invariant), so the
 * asset scope excludes it without a condition; every scope that reads files without an asset does not.
 *
 * @param scope the scope
 * @returns the condition
 */
function scopeMatches(scope: FileScope) {
  switch (scope.kind) {
    case 'all':
      return live();
    case 'inbox':
      return and(isNull(file.assetId), live());
    case 'asset':
      return eq(file.assetId, scope.assetId);
    case 'trash':
      return trashed();
  }
}

/**
 * The WHERE of a file list: scope, role, kind, a waiting proposal or none, every tag on the file
 * itself, and every query word a substring of the folded file name or a word prefix of one of the
 * file's tags (Plan decision 2). Null when a requested tag does not exist, so nothing can match.
 * Written against the outer `file` row; also the file filter of analysis targets.
 *
 * @param reader the caller's transaction
 * @param filter the filters
 * @returns the condition; null when a requested tag does not exist
 */
export function fileListWhere(reader: ListTransaction, filter: FileListFilter): { where: SQL | undefined } | null {
  const conditions: (SQL | undefined)[] = [scopeMatches(filter.scope)];
  if (filter.role !== undefined) conditions.push(eq(file.role, filter.role));
  if (filter.kind !== undefined) conditions.push(eq(file.kind, filter.kind));
  if (filter.ids !== undefined) conditions.push(inArray(file.id, [...filter.ids]));
  if (filter.hasProposal !== undefined) conditions.push(proposalMatches(filter.hasProposal));
  const tagConditions = tagsMatch(reader, filter.tagNames);
  if (tagConditions === null) return null;
  conditions.push(...tagConditions);
  conditions.push(...wordsMatch(filter.query));
  return { where: and(...conditions) };
}

/**
 * The files a tag proposal waits for, or the files without one.
 *
 * @param hasProposal true for the files with a proposal
 * @returns the condition
 */
function proposalMatches(hasProposal: boolean): SQL {
  const fileId = qualified(file, file.id);
  const proposed = sql`exists (select 1 from ${fileAnalysisProposal} where ${qualified(fileAnalysisProposal, fileAnalysisProposal.fileId)} = ${fileId})`;
  return hasProposal ? proposed : sql`not ${proposed}`;
}

/**
 * One condition per requested tag: the file carries it itself.
 *
 * @param reader the caller's transaction
 * @param tagNames the normalised tag names
 * @returns the conditions; null when a requested tag does not exist
 */
function tagsMatch(reader: ListTransaction, tagNames: readonly string[] | undefined): SQL[] | null {
  const names = [...new Set(tagNames ?? [])];
  if (names.length === 0) return [];
  const tagIds = reader.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
  if (tagIds.length < names.length) return null;
  const fileId = qualified(file, file.id);
  return tagIds.map(
    ({ id }) =>
      sql`exists (select 1 from ${fileTag} where ${qualified(fileTag, fileTag.fileId)} = ${fileId} and ${qualified(fileTag, fileTag.tagId)} = ${id})`,
  );
}

/**
 * One condition per query word: a substring of the folded file name or a word prefix of one of the file's tags.
 *
 * @param query the typed search text
 * @returns the conditions; none without a query
 */
function wordsMatch(query: string | undefined): SQL[] {
  const fileId = qualified(file, file.id);
  return (query === undefined ? [] : searchWords(query)).map(foldSearchWord).map(
    (word) =>
      sql`(instr(af_fold(${qualified(file, file.originalName)}), ${word}) > 0 or exists (
        select 1 from ${fileTag} ft join ${tag} t on t.id = ft.tag_id
        where ft.file_id = ${fileId} and af_word_prefix(t.name, ${word})))`,
  );
}

/**
 * The page statement: newest import first; in the trash newest deletion first.
 *
 * @param reader the caller's transaction
 * @param query the scope and the page
 * @param where the condition of the filters
 * @returns the statement
 */
export function pageQuery(reader: ListTransaction, query: FileQuery, where: SQL | undefined) {
  const order =
    query.scope.kind === 'trash' ? [desc(file.deletedAt), desc(file.id)] : [desc(file.importedAt), desc(file.id)];
  return reader
    .select()
    .from(file)
    .where(where)
    .orderBy(...order)
    .limit(query.limit)
    .offset(query.offset);
}

/**
 * The count statement.
 *
 * @param reader the caller's transaction
 * @param where the condition of the filters
 * @returns the statement
 */
export function countQuery(reader: ListTransaction, where: SQL | undefined) {
  return reader.select({ n: count() }).from(file).where(where);
}

/**
 * The page and count statements of a file list. Exported for the query plan test.
 *
 * @param reader the caller's transaction
 * @param query the filters and the page
 * @returns the statements; null when a requested tag does not exist
 */
export function fileListSql(reader: ListTransaction, query: FileQuery): { page: SQL; count: SQL } | null {
  const filter = fileListWhere(reader, query);
  if (filter === null) return null;
  return { page: pageQuery(reader, query, filter.where).getSQL(), count: countQuery(reader, filter.where).getSQL() };
}
