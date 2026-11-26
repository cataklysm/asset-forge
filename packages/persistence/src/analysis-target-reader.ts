import { ACTIVE_JOB_STATUSES, ANALYZE_FILE_JOB, normalizeTagName, type AnalysisPreview, type AnalysisTarget } from '@assetforge/contracts';
import type { AnalysisFingerprint, AnalysisTargetEntry, AnalysisTargetReader } from '@assetforge/core';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileListWhere } from './file-repository.js';
import { qualified } from './qualified.js';
import { file, fileAnalysis, fileAnalysisProposal, job } from './schema.js';
import { matchingAssetIds, type Tx } from './search-index.js';

const fileId = qualified(file, file.id);
const fileSha256 = qualified(file, file.sha256);

/**
 * Normalised, distinct tag names; null when one of them is not a valid tag name, so nothing can
 * match. Idempotent for names the core already normalised.
 */
function normalisedTagNames(names: readonly string[] | undefined): string[] | undefined | null {
  if (names === undefined) return undefined;
  const result = new Set<string>();
  for (const n of names) {
    const name = normalizeTagName(n);
    if (name === null) return null;
    result.add(name);
  }
  return [...result];
}

/**
 * The WHERE over the outer `file` row that selects the files of the target, built from the filters
 * of the file and asset lists. Null when nothing can match (no ids, an unknown or invalid tag).
 */
function targetWhere(tx: Tx, target: AnalysisTarget): { where: SQL | undefined } | null {
  switch (target.kind) {
    case 'files':
      return target.fileIds.length === 0 ? null : { where: inArray(file.id, [...new Set(target.fileIds)]) };
    case 'asset':
      return { where: eq(file.assetId, target.assetId) };
    case 'fileFilter': {
      const { tagNames, ...rest } = target.filter;
      const names = normalisedTagNames(tagNames);
      if (names === null) return null;
      return fileListWhere(tx, { ...rest, ...(names !== undefined && { tagNames: names }) });
    }
    case 'assetFilter': {
      const { tagNames, ...rest } = target.filter;
      const names = normalisedTagNames(tagNames);
      if (names === null) return null;
      const assetIds = matchingAssetIds(tx, { ...rest, ...(names !== undefined && { tagNames: names }) });
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
  }
}

/** Complete, with a checksum and of one of the MIME types (core's `isAnalysable`). */
function analysableSql(mimeTypes: readonly string[]): SQL {
  if (mimeTypes.length === 0) return sql`0`;
  return sql`(${qualified(file, file.status)} = 'complete' and ${fileSha256} is not null and ${qualified(file, file.mimeType)} in (${sql.join(
    [...new Set(mimeTypes)].map((m) => sql`${m}`),
    sql`, `,
  )}))`;
}

/** The file's current sha256 and the fingerprint equal its analysis row or its waiting proposal. */
function analysedSql(fp: AnalysisFingerprint): SQL {
  const matches = (table: typeof fileAnalysis | typeof fileAnalysisProposal) =>
    sql`exists (select 1 from ${table} where ${qualified(table, table.fileId)} = ${fileId}
      and ${qualified(table, table.sha256)} = ${fileSha256} and ${qualified(table, table.provider)} = ${fp.provider}
      and ${qualified(table, table.model)} = ${fp.model} and ${qualified(table, table.promptVersion)} = ${fp.promptVersion})`;
  return sql`(${fileSha256} is not null and (${matches(fileAnalysis)} or ${matches(fileAnalysisProposal)}))`;
}

/** An active analysis job holds the file's dedupe key, the way `enqueue` would skip it (served by the partial dedupe index). */
const queuedSql = sql`exists (select 1 from ${job} where ${qualified(job, job.dedupeKey)} = ${`${ANALYZE_FILE_JOB}:`} || ${fileId}
  and ${qualified(job, job.status)} in ${sql.raw(`(${ACTIVE_JOB_STATUSES.map((s) => `'${s}'`).join(', ')})`)})`;

const EMPTY: AnalysisPreview = { analysable: 0, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 };

/** Resolves analysis targets to files, one keyset page at a time, and counts them for a preview. */
export function createAnalysisTargetReader(db: BetterSQLite3Database): AnalysisTargetReader {
  return {
    async page(r): Promise<AnalysisTargetEntry[]> {
      // One read transaction, so the tag ids and the page describe the same snapshot.
      return db.transaction(
        (tx) => {
          const target = targetWhere(tx, r.target);
          if (target === null || r.limit <= 0) return [];
          const rows = tx
            .select({
              fileId: file.id,
              analysable: sql<number>`${analysableSql(r.mimeTypes)}`,
              analysed: sql<number>`${analysedSql(r.fingerprint)}`,
            })
            .from(file)
            .where(and(target.where, r.afterId === null ? undefined : gt(file.id, r.afterId)))
            .orderBy(asc(file.id))
            .limit(r.limit)
            .all();
          return rows.map((row) => ({ fileId: row.fileId, analysable: row.analysable === 1, analysed: row.analysed === 1 }));
        },
        { behavior: 'deferred' },
      );
    },
    async count(r): Promise<AnalysisPreview> {
      return db.transaction(
        (tx) => {
          const target = targetWhere(tx, r.target);
          if (target === null) return EMPTY;
          const analysable = analysableSql(r.mimeTypes);
          const analysed = analysedSql(r.fingerprint);
          const row = tx
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
    },
  };
}
