import { randomBytes } from 'node:crypto';
import { InvalidOperationError, type WorkspaceMeta, type WorkspaceMetaRepository } from '@assetforge/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workspace } from './schema.js';

/** The number of random bytes of a lineage id (32 hex characters). */
const LINEAGE_BYTES = 16;

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
 * A new random lineage id.
 *
 * @returns 32 lower-case hex characters
 */
export function newLineageId(): string {
  return randomBytes(LINEAGE_BYTES).toString('hex');
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
      lineageId: workspace.lineageId,
    })
    .from(workspace)
    .limit(1)
    .get();
  if (row === undefined) return null;
  // Migration 0021 gives every row a lineage, so a null cannot occur; it reads as empty and is never written back.
  return { ...row, lineageId: row.lineageId ?? '' };
}

/**
 * Writes the workspace row with a new lineage; refused when it exists.
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
      .values({
        id: meta.id,
        formatVersion: meta.formatVersion,
        name: meta.name,
        createdAt: meta.createdAt,
        lineageId: newLineageId(),
      })
      .run();
  });
}
