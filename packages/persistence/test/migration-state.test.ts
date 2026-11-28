import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/index.js';
import { readMigrationState } from '../src/migration-state.js';
import { migrationsUpTo } from './migrations-folder.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-migration-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A database file migrated with the given folder.
 *
 * @param folder the migrations
 * @returns the open connection; the caller closes it
 */
function migratedWith(folder: string): Database.Database {
  const sqlite = new Database(join(dir, 'state.sqlite'));
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

test('newerThanApp is false for a database migrated by the same journal', () => {
  const sqlite = migratedWith(MIGRATIONS_FOLDER);
  try {
    expect(readMigrationState(sqlite, MIGRATIONS_FOLDER)).toMatchObject({ pendingCount: 0, newerThanApp: false });
  } finally {
    sqlite.close();
  }
});

test('newerThanApp is true for a database migrated by a longer journal', async () => {
  const longer = await migrationsUpTo(join(dir, 'longer'), 100, [
    { tag: '9999_future', sql: 'CREATE TABLE future (id integer);' },
  ]);
  const sqlite = migratedWith(longer);
  try {
    expect(readMigrationState(sqlite, MIGRATIONS_FOLDER)).toMatchObject({ pendingCount: 0, newerThanApp: true });
  } finally {
    sqlite.close();
  }
});

test('newerThanApp is false for a database without migrations', () => {
  const sqlite = new Database(':memory:');
  try {
    expect(readMigrationState(sqlite, MIGRATIONS_FOLDER).newerThanApp).toBe(false);
  } finally {
    sqlite.close();
  }
});
