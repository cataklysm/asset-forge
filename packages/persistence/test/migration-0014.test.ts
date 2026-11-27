import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0013 = [
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
];
const TS = '2026-11-27T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0013, the way the generation studio build left the database. */
async function createDatabaseUpTo0013(): Promise<void> {
  const folder = join(dir, 'upto0013-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0013) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0013.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** One complete file and one succeeded edit generation of it. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', TS);
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
       VALUES (?, ?, 'oak.png', ?, 'image/png', 1, ?, 'image', 'complete', ?)`,
    ).run(uuid(3), uuid(2), `inbox/${uuid(3)}/oak.png`, 'a'.repeat(64), TS);
    s.prepare(
      `INSERT INTO generation (id, kind, status, provider_id, provider_name, provider_kind, model, prompt, parameters, created_at, finished_at)
       VALUES (?, 'edit', 'succeeded', 'p1', 'Venice', 'venice', 'qwen-image', 'Make it night', ?, ?, ?)`,
    ).run(uuid(10), JSON.stringify({ v: 1, aspectRatio: null, resolution: null, safeMode: true }), TS, TS);
    s.prepare(
      `INSERT INTO generation_input (generation_id, position, file_id, sha256, original_name) VALUES (?, 0, ?, ?, 'oak.png')`,
    ).run(uuid(10), uuid(3), 'a'.repeat(64));
  } finally {
    s.close();
  }
}

const count = (s: Database.Database, table: string) => (s.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig14-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0014', () => {
  test('0014 adds the prompt tables and the prompt reference of a generation, leaving old rows untouched', async () => {
    await createDatabaseUpTo0013();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.generations.get(uuid(10))).toMatchObject({
        status: 'succeeded',
        prompt: 'Make it night',
        inputs: [{ fileId: uuid(3), name: 'oak.png', sha256: 'a'.repeat(64), trashed: false }],
        promptId: null,
        promptVersionId: null,
        promptTitle: null,
        promptVersionNumber: null,
        promptVariables: null,
      });
      expect(await db.prompts.list({ words: [], tagNames: [], offset: 0, limit: 10 })).toEqual({ items: [], total: 0 });
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      for (const table of ['prompt', 'prompt_version', 'prompt_tag']) expect(count(check, table)).toBe(0);
      expect(check.pragma('foreign_key_list(generation)')).toEqual([
        expect.objectContaining({ table: 'prompt_version', from: 'prompt_version_id', on_delete: 'SET NULL' }),
      ]);
    } finally {
      check.close();
    }
  });
});
