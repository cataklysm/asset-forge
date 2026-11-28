import { MAX_FILE_ORIGINS } from '@assetforge/contracts';
import { NotFoundError, type FileOriginRepository } from '@assetforge/core';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file, fileOrigin } from './schema.js';

/** Bound parameters per `IN` list, well below SQLite's limit. */
const CHUNK = 500;

/**
 * The file origin repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createFileOriginRepository(database: BetterSQLite3Database): FileOriginRepository {
  return {
    listByFile: (fileId) => listByFile(database, fileId),
    get: (id) => getOrigin(database, id),
    findCompleteFileByUrl: (url) => findCompleteFileByUrl(database, url),
    knownUrls: (urls) => knownUrls(database, urls),
    insert: (row) => insertOrigin(database, row),
  };
}

/**
 * The origins of a file, oldest first.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns the origins
 */
async function listByFile(
  database: BetterSQLite3Database,
  fileId: string,
): ReturnType<FileOriginRepository['listByFile']> {
  return database
    .select({ id: fileOrigin.id, url: fileOrigin.url, createdAt: fileOrigin.createdAt })
    .from(fileOrigin)
    .where(eq(fileOrigin.fileId, fileId))
    .orderBy(asc(fileOrigin.createdAt), asc(fileOrigin.id))
    .all();
}

/**
 * One origin row.
 *
 * @param database the workspace database
 * @param id the origin
 * @returns the row; null when unknown
 */
async function getOrigin(database: BetterSQLite3Database, id: string): ReturnType<FileOriginRepository['get']> {
  return database.select().from(fileOrigin).where(eq(fileOrigin.id, id)).get() ?? null;
}

/**
 * The earliest imported complete file with this origin.
 *
 * @param database the workspace database
 * @param url the origin URL
 * @returns the file id; null when none
 */
async function findCompleteFileByUrl(database: BetterSQLite3Database, url: string): Promise<string | null> {
  const row = database
    .select({ id: file.id })
    .from(fileOrigin)
    .innerJoin(file, eq(file.id, fileOrigin.fileId))
    .where(and(eq(fileOrigin.url, url), eq(file.status, 'complete')))
    .orderBy(asc(file.importedAt), asc(file.id))
    .limit(1)
    .get();
  return row?.id ?? null;
}

/**
 * The URLs that are the origin of a complete file, read in chunks.
 *
 * @param database the workspace database
 * @param urls the URLs to check
 * @returns the known ones
 */
async function knownUrls(database: BetterSQLite3Database, urls: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  const distinct = [...new Set(urls)];
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const rows = database
      .selectDistinct({ url: fileOrigin.url })
      .from(fileOrigin)
      .innerJoin(file, eq(file.id, fileOrigin.fileId))
      .where(and(inArray(fileOrigin.url, distinct.slice(i, i + CHUNK)), eq(file.status, 'complete')))
      .all();
    for (const row of rows) known.add(row.url);
  }
  return known;
}

/**
 * Inserts the origin unless the file has it or is at the limit.
 *
 * @param database the workspace database
 * @param row the origin row
 * @returns false when nothing was inserted; rejects with NotFoundError when the file does not exist
 */
async function insertOrigin(
  database: BetterSQLite3Database,
  row: Parameters<FileOriginRepository['insert']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const owner = transaction.select({ id: file.id }).from(file).where(eq(file.id, row.fileId)).get();
    if (owner === undefined) throw new NotFoundError(`File ${row.fileId} does not exist`);
    const existing =
      transaction.select({ n: count() }).from(fileOrigin).where(eq(fileOrigin.fileId, row.fileId)).get()?.n ?? 0;
    if (existing >= MAX_FILE_ORIGINS) return false;
    return (
      transaction
        .insert(fileOrigin)
        .values(row)
        .onConflictDoNothing({ target: [fileOrigin.fileId, fileOrigin.url] })
        .run().changes > 0
    );
  });
}
