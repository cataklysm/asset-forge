import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const PHASE_3A_TAGS = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0003, the way a phase 3a build left the database. */
async function createPhase3aDatabase(): Promise<void> {
  const folder = join(dir, 'phase3a-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of PHASE_3A_TAGS) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => PHASE_3A_TAGS.includes(e.tag));
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
  dir = await mkdtemp(join(tmpdir(), 'af-mig4-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0004', () => {
  test('0004 applies to a phase 3a database', async () => {
    await createPhase3aDatabase();
    seedAssetWithFile();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await db.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.prepare('SELECT kind FROM file WHERE id = ?').get(uuid(20))).toEqual({ kind: 'other' });
      expect(check.prepare('SELECT derived_data_version AS v FROM workspace').get()).toEqual({ v: null });
      expect(check.prepare('SELECT count(*) AS n FROM asset_search').get()).toEqual({ n: 0 });
      expect(check.prepare('SELECT count(*) AS n FROM asset_search_map').get()).toEqual({ n: 0 });
      expect(check.prepare('SELECT id, name, status FROM asset').all()).toEqual([
        { id: uuid(10), name: 'Pump', status: 'draft' },
      ]);
      expect(
        check.prepare('SELECT id, original_name AS n, relative_path AS p, status FROM file').all(),
      ).toEqual([{ id: uuid(20), n: 'a.png', p: 'files/a.png', status: 'complete' }]);
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }

    // The manager's open runs the derived-data step right after.
    const reopened = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      await reopened.ensureDerivedData();
      const byName = await reopened.assets.list({ limit: 10, offset: 0, query: 'pump' });
      expect(byName.items.map((a) => a.id)).toEqual([uuid(10)]);
      const byFileName = await reopened.assets.list({ limit: 10, offset: 0, query: 'a.png' });
      expect(byFileName.items.map((a) => a.id)).toEqual([uuid(10)]);
    } finally {
      await reopened.close();
    }
    const after = new Database(dbPath, { readonly: true });
    try {
      expect(after.prepare('SELECT kind FROM file WHERE id = ?').get(uuid(20))).toEqual({ kind: 'image' });
    } finally {
      after.close();
    }
  });

  test('0004 creates the tag tables with their keys', async () => {
    await createPhase3aDatabase();
    seedAssetWithFile();
    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await db.close();

    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.prepare('INSERT INTO tag (id, name, display_name, created_at) VALUES (?, ?, ?, ?)').run(uuid(30), 'rust', 'Rust', TS);
      expect(() =>
        sqlite.prepare('INSERT INTO tag (id, name, display_name, created_at) VALUES (?, ?, ?, ?)').run(uuid(31), 'rust', 'RUST', TS),
      ).toThrow(/UNIQUE/);

      const assetTag = sqlite.prepare('INSERT INTO asset_tag (asset_id, tag_id, origin, created_at) VALUES (?, ?, ?, ?)');
      assetTag.run(uuid(10), uuid(30), 'manual', TS);
      expect(() => assetTag.run(uuid(10), uuid(30), 'manual', TS)).toThrow(/UNIQUE|PRIMARY/);
      assetTag.run(uuid(10), uuid(30), 'ai', TS);
      expect(() => assetTag.run(uuid(10), uuid(30), 'x', TS)).toThrow(/CHECK/);

      const fileTag = sqlite.prepare('INSERT INTO file_tag (file_id, tag_id, origin, created_at) VALUES (?, ?, ?, ?)');
      fileTag.run(uuid(20), uuid(30), 'manual', TS);
      expect(() => fileTag.run(uuid(20), uuid(30), 'manual', TS)).toThrow(/UNIQUE|PRIMARY/);
      fileTag.run(uuid(20), uuid(30), 'ai', TS);
      expect(() => fileTag.run(uuid(20), uuid(30), 'x', TS)).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });
});
