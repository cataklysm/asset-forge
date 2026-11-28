import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/** The migrations table Drizzle keeps its applied migrations in. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

/** How far a database is migrated, compared with a migrations folder. */
export interface MigrationState {
  /** The number of rows in the migrations table: the migrations applied so far. */
  appliedCount: number;
  /** The number of migrations of the folder that the next `migrate` would apply. */
  pendingCount: number;
}

/**
 * Reads how far the database is migrated without writing anything (the migrations table is not created). It
 * follows Drizzle's own rule: a migration is pending when its journal time is later than the newest applied one.
 *
 * @param sqlite the open connection
 * @param migrationsFolder the migrations that are about to be applied
 * @returns the applied and the pending count
 */
export function readMigrationState(sqlite: Database.Database, migrationsFolder: string): MigrationState {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (!hasMigrationsTable(sqlite)) return { appliedCount: 0, pendingCount: migrations.length };
  const row = sqlite
    .prepare(`SELECT count(*) AS appliedCount, max(created_at) AS newest FROM ${MIGRATIONS_TABLE}`)
    .get() as { appliedCount: number; newest: number | string | null };
  const newest = row.newest === null ? undefined : Number(row.newest);
  const pendingCount = migrations.filter((migration) => newest === undefined || newest < migration.folderMillis).length;
  return { appliedCount: row.appliedCount, pendingCount };
}

/**
 * Whether the database has Drizzle's migrations table.
 *
 * @param sqlite the open connection
 * @returns true when the table exists
 */
function hasMigrationsTable(sqlite: Database.Database): boolean {
  const row = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE);
  return row !== undefined;
}
