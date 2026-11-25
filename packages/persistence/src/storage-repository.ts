import type { StorageRef, StorageRepository } from '@assetforge/core';
import { asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { storage } from './schema.js';

export function createStorageRepository(db: BetterSQLite3Database): StorageRepository {
  // Only the workspace root exists in this phase; the oldest row is the primary storage.
  const primary = (tx: Pick<BetterSQLite3Database, 'select'>): StorageRef | null =>
    tx.select().from(storage).orderBy(asc(storage.createdAt), asc(storage.id)).limit(1).get() ?? null;

  return {
    async getPrimary() {
      return primary(db);
    },
    async ensurePrimary(r) {
      return db.transaction((tx) => {
        const existing = primary(tx);
        if (existing) return existing;
        const row: StorageRef = { id: r.id, kind: 'workspace_root', createdAt: r.createdAt };
        tx.insert(storage).values(row).run();
        return row;
      });
    },
  };
}
