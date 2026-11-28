import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0009 = [
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
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0009, the way the file trash build left the database. */
async function createDatabaseUpTo0009(): Promise<void> {
  const folder = join(dir, 'upto0009-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0009) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0009.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** One file with an analysis row and a waiting proposal, both written before analysis prompts existed. */
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
       VALUES (?, ?, 'a.png', ?, 'image/png', ?, 'complete', 'image', ?)`,
    ).run(uuid(20), uuid(2), `inbox/${uuid(20)}_a.png`, SHA, TS);
    s.prepare(
      `INSERT INTO file_analysis (file_id, sha256, provider, model, prompt_version, analysed_at)
       VALUES (?, ?, 'ollama', 'qwen', 1, ?)`,
    ).run(uuid(20), SHA, TS);
    s.prepare(
      `INSERT INTO file_analysis_proposal (file_id, sha256, provider, model, prompt_version, tags, created_at)
       VALUES (?, ?, 'ollama', 'qwen', 1, ?, ?)`,
    ).run(uuid(20), SHA, JSON.stringify([{ name: 'oak', displayName: 'Oak' }]), TS);
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig10-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0010', () => {
  test('0010 keeps the analysis and proposal rows and adds a null prompt_name to both', async () => {
    await createDatabaseUpTo0009();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.analyses.get(uuid(20))).toEqual({
        fileId: uuid(20),
        sha256: SHA,
        provider: 'ollama',
        model: 'qwen',
        promptVersion: 1,
        promptName: null,
        analysedAt: TS,
      });
      expect(await db.analyses.getProposal(uuid(20))).toMatchObject({
        model: 'qwen',
        promptName: null,
        tags: [{ name: 'oak', displayName: 'Oak' }],
        stale: false,
      });
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      for (const table of ['file_analysis', 'file_analysis_proposal']) {
        expect(check.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 1 });
        expect(check.prepare(`SELECT prompt_name FROM ${table}`).get(), table).toEqual({ prompt_name: null });
        expect(check.pragma(`table_info(${table})`), table).toContainEqual(
          expect.objectContaining({ name: 'prompt_name', type: 'TEXT', notnull: 0 }),
        );
      }
    } finally {
      check.close();
    }
  });
});
