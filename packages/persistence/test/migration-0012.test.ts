import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0011 = [
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
];
const TS = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T01:00:00.000Z';
const TYPE = 'vision.analyze_file';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0011, the way the asset sources build left the database. */
async function createDatabaseUpTo0011(): Promise<void> {
  const folder = join(dir, 'upto0011-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0011) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0011.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** One queued and one succeeded analysis job, written before jobs had a lane. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(
      uuid(1),
      'ws',
      TS,
    );
    const insert = s.prepare(
      `INSERT INTO job (id, type, resource_class, status, payload, attempt, created_at, finished_at, updated_at)
       VALUES (?, ?, 'local_gpu', ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(uuid(10), TYPE, 'queued', JSON.stringify({ version: 1 }), 0, TS, null, TS);
    insert.run(uuid(11), TYPE, 'succeeded', JSON.stringify({ version: 1 }), 1, TS, TS, TS);
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig12-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0012', () => {
  test('0012 keeps the jobs with a null lane, the queued one is still claimed, and the lane index exists', async () => {
    await createDatabaseUpTo0011();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', lane: null, payload: { version: 1 } });
      expect(await db.jobs.get(uuid(11))).toMatchObject({ status: 'succeeded', lane: null });
      expect(await db.jobs.claimNext({ resourceClass: 'local_gpu', types: [TYPE], now: LATER })).toMatchObject({
        id: uuid(10),
        status: 'running',
        lane: null,
      });
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      expect(check.prepare('SELECT id, provider_id FROM job ORDER BY id').all()).toEqual([
        { id: uuid(10), provider_id: null },
        { id: uuid(11), provider_id: null },
      ]);
      expect(check.pragma('table_info(job)')).toContainEqual(
        expect.objectContaining({ name: 'provider_id', type: 'TEXT', notnull: 0 }),
      );
      expect(check.pragma('index_info(job_provider_id_status_idx)')).toEqual([
        expect.objectContaining({ seqno: 0, name: 'provider_id' }),
        expect.objectContaining({ seqno: 1, name: 'status' }),
      ]);
    } finally {
      check.close();
    }
  });
});
