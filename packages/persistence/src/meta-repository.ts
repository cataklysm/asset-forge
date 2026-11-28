import { InvalidOperationError, type WorkspaceMeta, type WorkspaceMetaRepository } from '@assetforge/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workspace } from './schema.js';

/**
 * The workspace row over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createMetaRepository(database: BetterSQLite3Database): WorkspaceMetaRepository {
  return {
    get: () => getMeta(database),
    init: (meta) => initMeta(database, meta),
  };
}

/**
 * The workspace row.
 *
 * @param database the workspace database
 * @returns the row; null before `init`
 */
async function getMeta(database: BetterSQLite3Database): Promise<WorkspaceMeta | null> {
  const row = database
    .select({
      id: workspace.id,
      formatVersion: workspace.formatVersion,
      name: workspace.name,
      createdAt: workspace.createdAt,
    })
    .from(workspace)
    .limit(1)
    .get();
  // The lineage column comes with the next migration; until then every row answers an empty lineage.
  return row === undefined ? null : { ...row, lineageId: '' };
}

/**
 * Writes the workspace row; refused when it exists.
 *
 * @param database the workspace database
 * @param meta the row without the lineage
 * @returns nothing
 */
async function initMeta(database: BetterSQLite3Database, meta: Omit<WorkspaceMeta, 'lineageId'>): Promise<void> {
  database.transaction((transaction) => {
    if (transaction.select({ id: workspace.id }).from(workspace).limit(1).get()) {
      throw new InvalidOperationError('The workspace row already exists');
    }
    transaction
      .insert(workspace)
      .values({ id: meta.id, formatVersion: meta.formatVersion, name: meta.name, createdAt: meta.createdAt })
      .run();
  });
}
