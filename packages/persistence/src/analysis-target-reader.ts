import { ACTIVE_JOB_STATUSES, ANALYZE_FILE_JOB, normalizeTagName, type AnalysisPreview, type AnalysisTarget } from '@assetforge/contracts';
import type { AnalysisFingerprint, AnalysisTargetEntry, AnalysisTargetReader } from '@assetforge/core';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileListWhere } from './file-list.js';
import { qualified } from './qualified.js';
import { file, fileAnalysis, fileAnalysisProposal, job } from './schema.js';
import { matchingAssetIds } from './asset-search.js';
import type { IndexTransaction } from './search-index.js';

const fileId = qualified(file, file.id);
const fileSha256 = qualified(file, file.sha256);

/** The filter of an asset filter target. */
type AssetFilterTarget = Extract<AnalysisTarget, { kind: 'assetFilter' }>['filter'];

/**
 * Normalised, distinct tag names; null when one of them is not a valid tag name, so nothing can
 * match. Idempotent for names the core already normalised.
 *
 * @param names the tag names of a filter
 * @returns the normalised names; undefined without names, null for an invalid one
 */
function normalisedTagNames(names: readonly string[] | undefined): string[] | undefined | null {
  if (names === undefined) return undefined;
  const result = new Set<string>();
  for (const typed of names) {
    const name = normalizeTagName(typed);
    if (name === null) return null;
    result.add(name);
  }
  return [...result];
}

/**
 * The WHERE over the outer `file` row that selects the files of the target, built from the filters
 * of the file and asset lists. Null when nothing can match (no ids, an unknown or invalid tag).
 *
 * @param transaction the read transaction
 * @param target the analysis target
 * @returns the condition; null when nothing can match
 */
function targetWhere(transaction: IndexTransaction, target: AnalysisTarget): { where: SQL | undefined } | null {
  switch (target.kind) {
    case 'files':
      return target.fileIds.length === 0 ? null : { where: inArray(file.id, [...new Set(target.fileIds)]) };
    case 'asset':
      return { where: eq(file.assetId, target.assetId) };
    case 'fileFilter': {
      const { tagNames, ...rest } = target.filter;
      const names = normalisedTagNames(tagNames);
      if (names === null) return null;
      return fileListWhere(transaction, { ...rest, ...(names !== undefined && { tagNames: names }) });
    }
    case 'assetFilter':
      return assetFilterWhere(transaction, target.filter);
  }
}

/**
 * The WHERE of an asset filter target: the files of the matching assets.
 *
 * @param transaction the read transaction
 * @param filter the asset list filter
 * @returns the condition; null when nothing can match
 */
function assetFilterWhere(transaction: IndexTransaction, filter: AssetFilterTarget): { where: SQL | undefined } | null {
  const { tagNames, ...rest } = filter;
  const names = normalisedTagNames(tagNames);
  if (names === null) return null;
  const assetIds = matchingAssetIds(transaction, { ...rest, ...(names !== undefined && { tagNames: names }) });
  if (assetIds === null) return null;
  // `query` and `tagNames` select assets; `fileRole` and `fileKind` also narrow their files.
  return {
    where: and(
      sql`${qualified(file, file.assetId)} in (${assetIds})`,
      rest.fileRole === undefined ? undefined : eq(file.role, rest.fileRole),
      rest.fileKind === undefined ? undefined : eq(file.kind, rest.fileKind),
    ),
  };
}

/**
 * Complete, not in the trash, with a checksum and of one of the MIME types (core's `isAnalysable`).
 *
 * @param mimeTypes the analysable MIME types
 * @returns the condition over the outer `file` row
 */
function analysableSql(mimeTypes: readonly string[]): SQL {
  if (mimeTypes.length === 0) return sql`0`;
  return sql`(${qualified(file, file.status)} = 'complete' and ${qualified(file, file.deletedAt)} is null and ${fileSha256} is not null and ${qualified(file, file.mimeType)} in (${sql.join(
    [...new Set(mimeTypes)].map((mimeType) => sql`${mimeType}`),
    sql`, `,
  )}))`;
}

/**
 * The file's current sha256 and the fingerprint equal its analysis row or its waiting proposal.
 *
 * @param fingerprint the provider, model and prompt version of the analysis
 * @returns the condition over the outer `file` row
 */
function analysedSql(fingerprint: AnalysisFingerprint): SQL {
  const matches = (table: typeof fileAnalysis | typeof fileAnalysisProposal) =>
    sql`exists (select 1 from ${table} where ${qualified(table, table.fileId)} = ${fileId}
      and ${qualified(table, table.sha256)} = ${fileSha256} and ${qualified(table, table.provider)} = ${fingerprint.provider}
      and ${qualified(table, table.model)} = ${fingerprint.model} and ${qualified(table, table.promptVersion)} = ${fingerprint.promptVersion})`;
  return sql`(${fileSha256} is not null and (${matches(fileAnalysis)} or ${matches(fileAnalysisProposal)}))`;
}

/** An active analysis job holds the file's dedupe key, the way `enqueue` would skip it (served by the partial dedupe index). */
const queuedSql = sql`exists (select 1 from ${job} where ${qualified(job, job.dedupeKey)} = ${`${ANALYZE_FILE_JOB}:`} || ${fileId}
  and ${qualified(job, job.status)} in ${sql.raw(`(${ACTIVE_JOB_STATUSES.map((status) => `'${status}'`).join(', ')})`)})`;

/** The preview of a target without files. */
const EMPTY: AnalysisPreview = { analysable: 0, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 };

/**
 * Resolves analysis targets to files, one keyset page at a time, and counts them for a preview.
 *
 * @param database the workspace database
 * @returns the reader
 */
export function createAnalysisTargetReader(database: BetterSQLite3Database): AnalysisTargetReader {
  return {
    page: (request) => targetPage(database, request),
    count: (request) => targetCount(database, request),
  };
}

/**
 * One keyset page of the target's files with whether each is analysable and already analysed.
 *
 * @param database the workspace database
 * @param request the target, the MIME types, the fingerprint, the last id of the previous page and the limit
 * @returns the entries in id order
 */
async function targetPage(
  database: BetterSQLite3Database,
  request: Parameters<AnalysisTargetReader['page']>[0],
): Promise<AnalysisTargetEntry[]> {
  // One read transaction, so the tag ids and the page describe the same snapshot.
  return database.transaction(
    (transaction) => {
      const target = targetWhere(transaction, request.target);
      if (target === null || request.limit <= 0) return [];
      const rows = transaction
        .select({
          fileId: file.id,
          analysable: sql<number>`${analysableSql(request.mimeTypes)}`,
          analysed: sql<number>`${analysedSql(request.fingerprint)}`,
        })
        .from(file)
        .where(and(target.where, request.afterId === null ? undefined : gt(file.id, request.afterId)))
        .orderBy(asc(file.id))
        .limit(request.limit)
        .all();
      return rows.map((row) => ({ fileId: row.fileId, analysable: row.analysable === 1, analysed: row.analysed === 1 }));
    },
    { behavior: 'deferred' },
  );
}

/**
 * The counts of a preview over every file of the target.
 *
 * @param database the workspace database
 * @param request the target, the MIME types and the fingerprint
 * @returns the counts
 */
async function targetCount(
  database: BetterSQLite3Database,
  request: Parameters<AnalysisTargetReader['count']>[0],
): Promise<AnalysisPreview> {
  return database.transaction(
    (transaction) => {
      const target = targetWhere(transaction, request.target);
      if (target === null) return EMPTY;
      const analysable = analysableSql(request.mimeTypes);
      const analysed = analysedSql(request.fingerprint);
      const row = transaction
        .select({
          notAnalysable: sql<number>`coalesce(sum(not ${analysable}), 0)`,
          alreadyAnalysed: sql<number>`coalesce(sum(${analysable} and ${analysed}), 0)`,
          alreadyQueued: sql<number>`coalesce(sum(${analysable} and not ${analysed} and ${queuedSql}), 0)`,
          analysable: sql<number>`coalesce(sum(${analysable} and not ${analysed} and not ${queuedSql}), 0)`,
        })
        .from(file)
        .where(target.where)
        .get();
      return row ?? EMPTY;
    },
    { behavior: 'deferred' },
  );
}
