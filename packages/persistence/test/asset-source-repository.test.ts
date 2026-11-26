import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);

const UP_TO_0010 = [
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
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-sources-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('asset source repository', () => {
  let db: WorkspaceDatabase;

  beforeEach(async () => {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T1 });
    await db.assetTypes.insertMissing([
      { id: TYPE_ID, key: BUILT_IN_ASSET_TYPES[0]!.key, name: 'T', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  async function addAsset(n: number): Promise<Asset> {
    const a: Asset = { id: uuid(n), name: `A${n}`, typeId: TYPE_ID, description: '', status: 'draft', createdAt: T1, updatedAt: T1 };
    await db.assets.insert(a);
    return a;
  }

  test('lists by created_at, then id', async () => {
    const a = await addAsset(10);
    expect(await db.assetSources.insert({ id: uuid(102), assetId: a.id, url: 'https://example.org/late', createdAt: T2 })).toBe(true);
    expect(await db.assetSources.insert({ id: uuid(101), assetId: a.id, url: 'https://example.org/b', createdAt: T1 })).toBe(true);
    expect(await db.assetSources.insert({ id: uuid(100), assetId: a.id, url: 'https://example.org/a', createdAt: T1 })).toBe(true);
    expect(await db.assetSources.listByAsset(a.id)).toEqual([
      { id: uuid(100), url: 'https://example.org/a', createdAt: T1 },
      { id: uuid(101), url: 'https://example.org/b', createdAt: T1 },
      { id: uuid(102), url: 'https://example.org/late', createdAt: T2 },
    ]);
  });

  test('an asset carries a url once; another asset may carry it too', async () => {
    const a = await addAsset(10);
    const b = await addAsset(11);
    const url = 'https://example.org/';
    expect(await db.assetSources.insert({ id: uuid(100), assetId: a.id, url, createdAt: T1 })).toBe(true);
    expect(await db.assetSources.insert({ id: uuid(101), assetId: a.id, url, createdAt: T2 })).toBe(false);
    expect(await db.assetSources.listByAsset(a.id)).toEqual([{ id: uuid(100), url, createdAt: T1 }]);
    expect(await db.assetSources.insert({ id: uuid(102), assetId: b.id, url, createdAt: T1 })).toBe(true);
    expect(await db.assetSources.countByAsset(a.id)).toBe(1);
    expect(await db.assetSources.countByAsset(b.id)).toBe(1);
  });

  test('get returns the row with its asset; count and remove', async () => {
    const a = await addAsset(10);
    expect(await db.assetSources.countByAsset(a.id)).toBe(0);
    await db.assetSources.insert({ id: uuid(100), assetId: a.id, url: 'https://example.org/x', createdAt: T1 });
    await db.assetSources.insert({ id: uuid(101), assetId: a.id, url: 'https://example.org/y', createdAt: T1 });
    expect(await db.assetSources.get(uuid(100))).toEqual({
      id: uuid(100),
      assetId: a.id,
      url: 'https://example.org/x',
      createdAt: T1,
    });
    expect(await db.assetSources.get(uuid(999))).toBeNull();
    expect(await db.assetSources.countByAsset(a.id)).toBe(2);
    expect(await db.assetSources.remove(uuid(100))).toBe(true);
    expect(await db.assetSources.remove(uuid(100))).toBe(false);
    expect(await db.assetSources.get(uuid(100))).toBeNull();
    expect(await db.assetSources.countByAsset(a.id)).toBe(1);
  });
});

describe('migration 0011', () => {
  /** Applies only the migrations up to 0010, the way the build before asset sources left the database. */
  async function createDatabaseUpTo0010(dbPath: string): Promise<void> {
    const folder = join(dir, 'upto0010-migrations');
    await mkdir(join(folder, 'meta'), { recursive: true });
    for (const tag of UP_TO_0010) {
      await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
    }
    const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => UP_TO_0010.includes(e.tag));
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: folder });
    } finally {
      sqlite.close();
    }
  }

  test('0011 keeps the assets and adds an empty asset_source table', async () => {
    const dbPath = join(dir, 'assetforge.sqlite');
    await createDatabaseUpTo0010(dbPath);
    const seed = new Database(dbPath);
    try {
      seed.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', T1);
      seed.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), T1);
      seed
        .prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'character', 'T', 0, 1)")
        .run(uuid(3));
      seed
        .prepare("INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at) VALUES (?, 'Door', ?, '', 'draft', ?, ?)")
        .run(uuid(10), uuid(3), T1, T1);
    } finally {
      seed.close();
    }

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.assets.get(uuid(10))).toMatchObject({ id: uuid(10), name: 'Door' });
      expect(await db.assetSources.listByAsset(uuid(10))).toEqual([]);
      expect(await db.assetSources.insert({ id: uuid(100), assetId: uuid(10), url: 'https://example.org/', createdAt: T1 })).toBe(true);
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      expect(check.prepare('SELECT count(*) AS n FROM asset').get()).toEqual({ n: 1 });
      expect(check.prepare('SELECT count(*) AS n FROM asset_source').get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });
});
