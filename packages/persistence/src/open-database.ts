import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDatabase } from '@assetforge/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createFileRepository } from './file-repository.js';
import { createMetaRepository } from './meta-repository.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function openWorkspaceDatabase(
  dbFilePath: string,
  migrationsFolder: string,
): Promise<WorkspaceDatabase> {
  mkdirSync(dirname(dbFilePath), { recursive: true });
  const sqlite = new Database(dbFilePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    return {
      meta: createMetaRepository(db),
      files: createFileRepository(db),
      async close() {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
