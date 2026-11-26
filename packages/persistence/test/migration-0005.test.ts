import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0004 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0003, the way a phase 3a build left the database. */
async function createDatabaseUpTo0004(): Promise<void> {
  const folder = join(dir, 'upto0004-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0004) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0004.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

function seedAssetWithFile(): void {
  const seed = new Database(dbPath);
  try {
    seed.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', TS);
    seed.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), TS);
    seed
      .prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'prop', 'Prop', 0, 1)")
      .run(uuid(3));
    seed
      .prepare(
        `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
         VALUES (?, 'Pump', ?, '', 'draft', ?, ?)`,
      )
      .run(uuid(10), uuid(3), TS, TS);
    seed
      .prepare(
        `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, status, imported_at)
         VALUES (?, ?, ?, 'reference', 'a.png', 'files/a.png', 'image/png', 'complete', ?)`,
      )
      .run(uuid(20), uuid(2), uuid(10), TS);
  } finally {
    seed.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig5-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0005', () => {
  test('0005 keeps a complete file and gives it empty dimensions', async () => {
    await createDatabaseUpTo0004();
    seedAssetWithFile();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      const record = await db.files.get(uuid(20));
      expect(record).toMatchObject({ id: uuid(20), originalName: 'a.png', status: 'complete', width: null, height: null });
    } finally {
      await db.close();
    }

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.prepare('SELECT width, height FROM file WHERE id = ?').get(uuid(20))).toEqual({ width: null, height: null });
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  });
});
