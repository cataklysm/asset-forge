import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0006 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
  '0006_cuddly_micromacro',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0006, the way a phase 4a build left the database. */
async function createDatabaseUpTo0006(): Promise<void> {
  const folder = join(dir, 'upto0006-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0006) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0006.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(
      uuid(1),
      'ws',
      TS,
    );
    s.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, sha256, status, kind, imported_at)
       VALUES (?, ?, 'a.png', 'inbox/a.png', 'image/png', ?, 'complete', 'image', ?)`,
    ).run(uuid(20), uuid(2), SHA, TS);
    s.prepare(
      `INSERT INTO file_analysis (file_id, sha256, provider, model, prompt_version, analysed_at) VALUES (?, ?, 'ollama', 'qwen', 1, ?)`,
    ).run(uuid(20), SHA, TS);
    s.prepare(
      `INSERT INTO job (id, type, resource_class, status, file_id, payload, dedupe_key, attempt, created_at, updated_at)
       VALUES (?, 'vision.analyze_file', 'local_gpu', 'queued', ?, '{"version":1}', ?, 0, ?, ?)`,
    ).run(uuid(30), uuid(20), `vision.analyze_file:${uuid(20)}`, TS, TS);
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig7-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0007', () => {
  test('0007 keeps existing rows and adds the proposal table', async () => {
    await createDatabaseUpTo0006();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.files.get(uuid(20))).toMatchObject({ id: uuid(20), status: 'complete', hasProposal: false });
      expect(await db.analyses.get(uuid(20))).toMatchObject({ model: 'qwen' });
      expect(await db.jobs.get(uuid(30))).toMatchObject({ status: 'queued', payload: { version: 1 } });
      expect(await db.analyses.getProposal(uuid(20))).toBeNull();
      expect(
        await db.analyses.propose({
          fileId: uuid(20),
          sha256: SHA,
          provider: 'ollama',
          model: 'qwen',
          promptVersion: 1,
          tags: [{ name: 'blue', displayName: 'Blue' }],
          promptName: null,
          createdAt: TS,
        }),
      ).toBe(true);
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      check.pragma('foreign_keys = ON');
      expect(() =>
        check
          .prepare(
            `INSERT INTO file_analysis_proposal (file_id, sha256, provider, model, prompt_version, tags, created_at)
             VALUES (?, ?, 'ollama', 'm', 1, '[]', ?)`,
          )
          .run(uuid(99), SHA, TS),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        check
          .prepare(
            `INSERT INTO file_analysis_proposal (file_id, sha256, provider, model, prompt_version, tags, created_at)
             VALUES (?, NULL, 'ollama', 'm', 1, '[]', ?)`,
          )
          .run(uuid(20), TS),
      ).toThrow(/NOT NULL/);
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  });
});
