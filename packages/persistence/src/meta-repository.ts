import type { WorkspaceMeta, WorkspaceMetaRepository } from '@assetforge/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workspace } from './schema.js';

export function createMetaRepository(db: BetterSQLite3Database): WorkspaceMetaRepository {
  return {
    async get(): Promise<WorkspaceMeta | null> {
      return db.select().from(workspace).limit(1).get() ?? null;
    },
    async init(meta: WorkspaceMeta): Promise<void> {
      db.insert(workspace).values(meta).run();
    },
  };
}
