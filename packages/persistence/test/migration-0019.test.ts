import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-11-28T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000001';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-migration19-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('adds durable crawl storage to an existing workspace without changing its queued jobs', async () => {
  const folder = join(dir, 'legacy-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx < 19);
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const path = join(dir, 'workspace.db');
  const old = await openWorkspaceDatabase(path, folder);
  let before;
  try {
    await old.jobs.enqueue({
      jobs: [
        {
          id: ID,
          type: 'file.download',
          resourceClass: 'io',
          fileId: null,
          lane: 'example.com',
          payload: { version: 1 },
          dedupeKey: null,
        },
      ],
      now: TS,
    });
    before = await old.jobs.get(ID);
  } finally {
    await old.close();
  }
  const upgraded = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
  try {
    expect(await upgraded.jobs.get(ID)).toEqual(before);
    expect(await upgraded.siteCrawls.list({ limit: 20, offset: 0 })).toEqual({ items: [], total: 0 });
  } finally {
    await upgraded.close();
  }
  const sqlite = new Database(path);
  try {
    const columns = sqlite.pragma('table_info(site_crawl)') as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['id', 'profile_id', 'progress', 'checkpoint', 'result']),
    );
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('foreign_key_list(site_crawl)')).toEqual([]);
  } finally {
    sqlite.close();
  }
});
