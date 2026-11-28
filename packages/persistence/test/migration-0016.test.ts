import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0015 = [
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
];
const TS = '2026-11-27T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0015, the way the URL import build left the database. */
async function createDatabaseUpTo0015(): Promise<void> {
  const folder = join(dir, 'upto0015-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0015) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0015.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** A complete image, and a video imported before the video kind existed (kind other, octet-stream). */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare(
      'INSERT INTO workspace (id, format_version, name, created_at, derived_data_version) VALUES (?, 1, ?, ?, 1)',
    ).run(uuid(1), 'ws', TS);
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    const insert = s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at, width, height)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'complete', ?, ?, ?)`,
    );
    insert.run(
      uuid(3),
      uuid(2),
      'oak.png',
      `inbox/${uuid(3)}_oak.png`,
      'image/png',
      'a'.repeat(64),
      'image',
      TS,
      64,
      48,
    );
    insert.run(
      uuid(4),
      uuid(2),
      'clip.mp4',
      `inbox/${uuid(4)}_clip.mp4`,
      'application/octet-stream',
      'b'.repeat(64),
      'other',
      TS,
      null,
      null,
    );
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig16-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0016', () => {
  test('0016 adds a null file.duration_ms and leaves the rows untouched; the derived-data step makes the video a video', async () => {
    await createDatabaseUpTo0015();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.files.get(uuid(3))).toMatchObject({
        originalName: 'oak.png',
        width: 64,
        height: 48,
        durationMs: null,
      });
      expect(await db.files.get(uuid(4))).toMatchObject({
        kind: 'other',
        mimeType: 'application/octet-stream',
        durationMs: null,
      });
      await db.ensureDerivedData();
      expect(await db.files.get(uuid(4))).toMatchObject({ kind: 'video', mimeType: 'video/mp4', thumbnail: true });
      expect(await db.files.get(uuid(3))).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      expect(check.prepare('SELECT duration_ms FROM file ORDER BY id').all()).toEqual([
        { duration_ms: null },
        { duration_ms: null },
      ]);
      const column = (check.pragma('table_info(file)') as { name: string; type: string; notnull: number }[]).find(
        (c) => c.name === 'duration_ms',
      );
      expect(column).toMatchObject({ type: 'INTEGER', notnull: 0 });
    } finally {
      check.close();
    }
  });
});
