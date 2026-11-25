import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const PHASE_2B_TAGS = ['0000_brainy_tag', '0001_regular_gideon', '0002_outgoing_franklin_richards'];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0002, the way a phase 2b build left the database. */
async function createPhase2bDatabase(): Promise<void> {
  const folder = join(dir, 'phase2b-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of PHASE_2B_TAGS) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => PHASE_2B_TAGS.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig3-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0003', () => {
  test('migration 0003 adds an empty cover column and fixes avif MIME types', async () => {
    await createPhase2bDatabase();
    const seed = new Database(dbPath);
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
    const insertFile = seed.prepare(
      `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, status, imported_at)
       VALUES (?, ?, ?, 'reference', ?, ?, ?, 'complete', ?)`,
    );
    insertFile.run(uuid(20), uuid(2), uuid(10), 'a.png', 'files/a.png', 'image/png', TS);
    insertFile.run(uuid(21), uuid(2), uuid(10), 'b.avif', 'files/b.avif', 'application/octet-stream', TS);
    insertFile.run(uuid(22), uuid(2), uuid(10), 'C.AVIF', 'files/C.AVIF', 'application/octet-stream', TS);
    seed.close();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await db.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      const cols = (table: string) =>
        (check.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
      const mime = (name: string) =>
        (check.prepare('SELECT mime_type AS m FROM file WHERE original_name = ?').get(name) as { m: string }).m;
      expect(cols('asset')).toContain('cover_file_id');
      expect(
        (check.prepare('SELECT cover_file_id AS c FROM asset WHERE id = ?').get(uuid(10)) as { c: unknown }).c,
      ).toBeNull();
      expect(mime('b.avif')).toBe('image/avif');
      expect(mime('C.AVIF')).toBe('image/avif');
      expect(mime('a.png')).toBe('image/png');
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  });
});
