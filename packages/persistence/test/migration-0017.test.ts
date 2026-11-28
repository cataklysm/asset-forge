import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0016 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
  '0006_cuddly_micromacro',
  '0007_daffy_doctor_faustus',
  '0008_neat_firestar',
  '0009_clever_shotgun',
  '0010_right_captain_stacy',
  '0011_eager_wonder_man',
  '0012_clear_kate_bishop',
  '0013_swift_purple_man',
  '0014_icy_prowler',
  '0015_bouncy_garia',
  '0016_youthful_gauntlet',
];
const TS = '2026-11-28T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0016, the way the video playback build left the database. */
async function createDatabaseUpTo0016(): Promise<void> {
  const folder = join(dir, 'upto0016-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0016) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0016.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** Two assets out of name order and two inbox files out of import order. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare(
      'INSERT INTO workspace (id, format_version, name, created_at, derived_data_version) VALUES (?, 1, ?, ?, 2)',
    ).run(uuid(1), 'ws', TS);
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    s.prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'prop', 'Prop', 0, 1)").run(
      uuid(3),
    );
    const insertFile = s.prepare(
      `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, 'image/png', 1, ?, 'image', 'complete', ?)`,
    );
    insertFile.run(uuid(10), uuid(2), null, null, 'old.png', `inbox/${uuid(10)}_old.png`, 'a'.repeat(64), TS);
    insertFile.run(
      uuid(11),
      uuid(2),
      null,
      null,
      'new.png',
      `inbox/${uuid(11)}_new.png`,
      'b'.repeat(64),
      '2026-11-28T11:00:00.000Z',
    );
    const insertAsset = s.prepare(
      `INSERT INTO asset (id, name, type_id, status, cover_file_id, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    );
    insertAsset.run(uuid(20), 'zebra', uuid(3), null, TS, TS);
    insertAsset.run(uuid(21), 'Apple', uuid(3), null, TS, TS);
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig17-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0017', () => {
  test('0017 only adds the four indexes and leaves the rows and their order untouched', async () => {
    await createDatabaseUpTo0016();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      const assets = await db.assets.list({ offset: 0, limit: 50 });
      expect(assets.items.map((item) => item.name)).toEqual(['Apple', 'zebra']);
      const inbox = await db.files.list({ scope: { kind: 'inbox' }, offset: 0, limit: 50 });
      expect(inbox.items.map((item) => item.originalName)).toEqual(['new.png', 'old.png']);
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      const indexes = (table: string) =>
        (check.pragma(`index_list(${table})`) as { name: string }[]).map((index) => index.name);
      expect(indexes('asset')).toEqual(expect.arrayContaining(['asset_name_lower_id_idx', 'asset_cover_file_id_idx']));
      expect(indexes('file')).toContain('file_asset_id_imported_at_id_idx');
      expect(indexes('generation')).toContain('generation_prompt_version_id_idx');
      const columns = (index: string) =>
        (check.pragma(`index_xinfo(${index})`) as { name: string | null; key: number }[])
          .filter((column) => column.key === 1)
          .map((column) => column.name);
      expect(columns('asset_name_lower_id_idx')).toEqual([null, 'id']);
      expect(columns('file_asset_id_imported_at_id_idx')).toEqual(['asset_id', 'imported_at', 'id']);
      expect(check.prepare('SELECT count(*) AS n FROM asset').get()).toEqual({ n: 2 });
      expect(check.prepare('SELECT count(*) AS n FROM file').get()).toEqual({ n: 2 });
    } finally {
      check.close();
    }
  });
});
