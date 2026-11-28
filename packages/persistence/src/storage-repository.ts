import type { StorageRef, StorageRepository } from '@assetforge/core';
import { asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { storage } from './schema.js';

/**
 * The storage repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createStorageRepository(database: BetterSQLite3Database): StorageRepository {
  return {
    getPrimary: async () => primary(database),
    ensurePrimary: (request) => ensurePrimary(database, request),
  };
}

/**
 * The primary storage. Only the workspace root exists in this phase; the oldest row is the primary storage.
 *
 * @param reader the database or the caller's transaction
 * @returns the storage; null when none exists
 */
function primary(reader: Pick<BetterSQLite3Database, 'select'>): StorageRef | null {
  return reader.select().from(storage).orderBy(asc(storage.createdAt), asc(storage.id)).limit(1).get() ?? null;
}

/**
 * The primary storage, written as the workspace root when none exists.
 *
 * @param database the workspace database
 * @param request the id and time of a new row
 * @returns the primary storage
 */
async function ensurePrimary(
  database: BetterSQLite3Database,
  request: Parameters<StorageRepository['ensurePrimary']>[0],
): Promise<StorageRef> {
  return database.transaction((transaction) => {
    const existing = primary(transaction);
    if (existing) return existing;
    const row: StorageRef = { id: request.id, kind: 'workspace_root', createdAt: request.createdAt };
    transaction.insert(storage).values(row).run();
    return row;
  });
}
