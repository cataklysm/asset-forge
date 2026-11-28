import { join } from 'node:path';
import { createBackupChecker, type BackupChecker } from '../src/backup-check.js';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

/** The workspace id of the fixtures. */
export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

/** The built worker (see `global-setup.ts`). */
export const WORKER_URL = new URL('../.test-build/backup-check-worker.mjs', import.meta.url);

/**
 * The real checker over the built worker and the shipped migrations.
 *
 * @param migrationsFolder the migrations the checker compares with
 * @returns the checker
 */
export function realChecker(migrationsFolder = MIGRATIONS_FOLDER): BackupChecker {
  return createBackupChecker({ workerUrl: WORKER_URL, migrationsFolder });
}

/**
 * Creates a closed workspace database with its row and returns its lineage.
 *
 * @param directory the directory
 * @param name the file name
 * @returns the path and the lineage
 */
export async function createWorkspaceDatabase(
  directory: string,
  name = 'assetforge.sqlite',
): Promise<{ path: string; lineageId: string }> {
  const path = join(directory, name);
  const database = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
  try {
    await database.meta.init({ id: WORKSPACE_ID, formatVersion: 1, name: 'Test', createdAt: '2026-01-01T00:00:00Z' });
    return { path, lineageId: (await database.meta.get())!.lineageId };
  } finally {
    await database.close();
  }
}

/**
 * The number of migrations shipped with the package.
 *
 * @returns the count
 */
export async function shippedMigrationCount(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}
