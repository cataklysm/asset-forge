import type { FileScope } from '@assetforge/contracts';
import { foldSearchWord, searchWords, type FileQuery } from '@assetforge/core';
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { file, fileAnalysisProposal, fileTag, tag } from './schema.js';

/**
 * Not in the trash. The unary `+` keeps `file_deleted_at_idx` out of the plan: nearly every row is
 * live, and without statistics SQLite would otherwise prefer it to the scope's `asset_id` key.
 */
export const live = () => sql`+${qualified(file, file.deletedAt)} is null`;

/**
 * In the trash. `unlikely` tells the planner that few rows are, so `file_deleted_at_idx` drives the
 * trash list even under expensive filters (it would otherwise scan `file`).
 */
export const trashed = () => sql`unlikely(${qualified(file, file.deletedAt)} is not null)`;

/**
 * The scope condition. A trashed file has no asset (the repositories keep that invariant), so the
 * asset scope excludes it without a condition; every scope that reads files without an asset does not.
 */
const scopeMatches = (scope: FileScope) => {
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
};

type ListTx = Pick<BetterSQLite3Database, 'select'>;

/**
 * The WHERE of a file list: scope, role, kind, a waiting proposal or none, every tag on the file
 * itself, and every query word a substring of the folded file name or a word prefix of one of the
 * file's tags (Plan decision 2). Null when a requested tag does not exist, so nothing can match.
 * Written against the outer `file` row; also the file filter of analysis targets.
 */
export function fileListWhere(tx: ListTx, q: Omit<FileQuery, 'limit' | 'offset'>): { where: SQL | undefined } | null {
  const fileId = qualified(file, file.id);
  const conditions: (SQL | undefined)[] = [scopeMatches(q.scope)];
  if (q.role !== undefined) conditions.push(eq(file.role, q.role));
  if (q.kind !== undefined) conditions.push(eq(file.kind, q.kind));
  if (q.ids !== undefined) conditions.push(inArray(file.id, [...q.ids]));
  if (q.hasProposal !== undefined) {
    const proposed = sql`exists (select 1 from ${fileAnalysisProposal} where ${qualified(fileAnalysisProposal, fileAnalysisProposal.fileId)} = ${fileId})`;
    conditions.push(q.hasProposal ? proposed : sql`not ${proposed}`);
  }
  const names = [...new Set(q.tagNames ?? [])];
  if (names.length > 0) {
    const tagIds = tx.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
    if (tagIds.length < names.length) return null;
    for (const { id } of tagIds) {
      conditions.push(
        sql`exists (select 1 from ${fileTag} where ${qualified(fileTag, fileTag.fileId)} = ${fileId} and ${qualified(fileTag, fileTag.tagId)} = ${id})`,
      );
    }
  }
  for (const word of (q.query === undefined ? [] : searchWords(q.query)).map(foldSearchWord)) {
    conditions.push(
      sql`(instr(af_fold(${qualified(file, file.originalName)}), ${word}) > 0 or exists (
        select 1 from ${fileTag} ft join ${tag} t on t.id = ft.tag_id
        where ft.file_id = ${fileId} and af_word_prefix(t.name, ${word})))`,
    );
  }
  return { where: and(...conditions) };
}

/** Newest import first; in the trash newest deletion first. */
export const pageQuery = (tx: ListTx, q: FileQuery, where: SQL | undefined) =>
  tx
    .select()
    .from(file)
    .where(where)
    .orderBy(...(q.scope.kind === 'trash' ? [desc(file.deletedAt), desc(file.id)] : [desc(file.importedAt), desc(file.id)]))
    .limit(q.limit)
    .offset(q.offset);

export const countQuery = (tx: ListTx, where: SQL | undefined) => tx.select({ n: count() }).from(file).where(where);

/** The page and count statements of a file list; null when a requested tag does not exist. Exported for the query plan test. */
export function fileListSql(tx: ListTx, q: FileQuery): { page: SQL; count: SQL } | null {
  const filter = fileListWhere(tx, q);
  if (filter === null) return null;
  return { page: pageQuery(tx, q, filter.where).getSQL(), count: countQuery(tx, filter.where).getSQL() };
}
