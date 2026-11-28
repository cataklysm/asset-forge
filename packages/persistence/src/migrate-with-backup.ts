import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { backupDatabase, pruneBackups, removeBackupLeftovers } from './database-backup.js';
import { readMigrationState } from './migration-state.js';

/** The options of the backup before pending migrations. */
export interface BackupOptions {
  /** The clock that stamps the backup name; the current time by default. */
  now?: () => Date;
}

/** What `migrateWithBackup` needs besides the connection. */
export interface MigrationPlan {
  /** The database file. */
  databaseFilePath: string;
  /** The migrations to apply. */
  migrationsFolder: string;
  /** Whether the database file existed before this open. */
  existed: boolean;
  /** The options of the backup. */
  backup: BackupOptions | undefined;
}

/**
 * Applies the pending migrations. An existing database with at least one pending migration is first copied
 * beside itself (naming and retention in `database-backup.ts`); a new or up-to-date one is not, and the derived
 * data step never asks for one. A failed backup refuses the migration, so the database stays as it was. A failed
 * migration is rolled back by Drizzle and thrown unchanged; its backup stays and nothing is restored. Old backups
 * are pruned only after a successful migration. Leftovers of an interrupted backup are removed first, every time.
 *
 * @param sqlite the open connection
 * @param database the Drizzle handle over it
 * @param plan the file, the migrations, whether the file existed and the backup options
 * @returns resolves once the database is migrated
 * @throws InvalidOperationError when the backup cannot be made
 */
export async function migrateWithBackup(
  sqlite: Database.Database,
  database: BetterSQLite3Database,
  plan: MigrationPlan,
): Promise<void> {
  await removeBackupLeftovers(plan.databaseFilePath);
  const state = plan.existed ? readMigrationState(sqlite, plan.migrationsFolder) : undefined;
  const needsBackup = state !== undefined && state.pendingCount > 0;
  if (needsBackup) {
    const now = plan.backup?.now ?? (() => new Date());
    await backupDatabase(sqlite, plan.databaseFilePath, state.appliedCount, now());
  }
  migrate(database, { migrationsFolder: plan.migrationsFolder });
  if (needsBackup) await pruneBackups(plan.databaseFilePath);
}
