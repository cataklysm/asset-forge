import { InvalidOperationError, type WorkspaceMeta, type WorkspaceMetaRepository } from '@assetforge/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workspace } from './schema.js';

export function createMetaRepository(db: BetterSQLite3Database): WorkspaceMetaRepository {
  return {
    async get(): Promise<WorkspaceMeta | null> {
      return (
        db
          .select({
            id: workspace.id,
            formatVersion: workspace.formatVersion,
            name: workspace.name,
            createdAt: workspace.createdAt,
          })
          .from(workspace)
          .limit(1)
          .get() ?? null
      );
    },
    async init(meta: WorkspaceMeta): Promise<void> {
      db.transaction((tx) => {
        if (tx.select({ id: workspace.id }).from(workspace).limit(1).get()) {
          throw new InvalidOperationError('The workspace row already exists');
        }
        tx.insert(workspace)
          .values({ id: meta.id, formatVersion: meta.formatVersion, name: meta.name, createdAt: meta.createdAt })
          .run();
      });
    },
  };
}
