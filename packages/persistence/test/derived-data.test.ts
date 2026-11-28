import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetType, FileKind } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { DERIVED_DATA_VERSION, MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE = uuid(900);
const TYPE = uuid(100);

const SNAPSHOT_SQL = `select m.asset_id, s.name, s.description, s.tags, s.file_names
  from asset_search s join asset_search_map m on m.rowid = s.rowid order by m.asset_id`;

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase;
let nextId: number;
const newId = () => uuid(nextId++);

async function openFresh(): Promise<WorkspaceDatabase> {
  return openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-derived-'));
  dbPath = join(dir, 'ws.db');
  db = await openFresh();
  nextId = 5000;
  await db.meta.init({ id: uuid(1), formatVersion: 1, name: 'ws', createdAt: TS });
  const types: AssetType[] = BUILT_IN_ASSET_TYPES.map((t, i) => ({
    id: uuid(100 + i),
    key: t.key,
    name: t.name,
    sortOrder: i,
    builtIn: true,
    defaultWorkflowTemplateId: null,
  }));
  await db.assetTypes.insertMissing(types);
  await db.storages.ensurePrimary({ id: STORAGE, createdAt: TS });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const asset = (n: number, name: string, patch: Partial<Asset> = {}): Asset => ({
  id: uuid(n),
  name,
  typeId: TYPE,
  description: '',
  status: 'draft',
  createdAt: TS,
  updatedAt: TS,
  ...patch,
});

const addFile = async (assetId: string | null, originalName: string, kind: FileKind = 'image') => {
  const id = newId();
  await db.files.insertPending({
    id,
    storageId: STORAGE,
    originalName,
    relativePath: `inbox/${id}.bin`,
    mimeType: 'application/octet-stream',
    importedAt: TS,
    kind,
  });
  await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
  if (assetId !== null) {
    await db.files.setPlacement(id, { relativePath: `assets/${assetId}/${id}.bin`, assetId, role: 'reference' });
  }
  return id;
};

/** Runs `fn` against a raw connection to the same database file. */
function raw<T>(fn: (sqlite: Database.Database) => T): T {
  const sqlite = new Database(dbPath);
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

const snapshot = () => raw((s) => s.prepare(SNAPSHOT_SQL).all());
const stamp = () =>
  raw((s) => (s.prepare('select derived_data_version as v from workspace').get() as { v: number | null }).v);
const setStamp = (v: number | null) => raw((s) => s.prepare('update workspace set derived_data_version = ?').run(v));
const kinds = () => raw((s) => s.prepare('select original_name as n, kind from file order by original_name').all());

/** Builds assets, tags, files and a committed move through the repositories (the incremental path). */
async function buildLibrary(): Promise<void> {
  await db.assets.insert(asset(1, 'Lantern', { description: 'A glowing light' }));
  await db.assets.insert(asset(2, 'Crate'));
  await db.assets.insert(asset(3, 'Barrel'));
  await db.tags.addToAsset({
    assetId: uuid(1),
    name: 'brass',
    displayName: 'Brass',
    origin: 'manual',
    newId: newId(),
    now: TS,
  });
  await db.tags.addToAsset({
    assetId: uuid(2),
    name: 'wooden',
    displayName: 'Wooden',
    origin: 'ai',
    newId: newId(),
    now: TS,
  });
  const lamp = await addFile(uuid(1), 'lamp.png');
  await db.tags.addToFile({
    fileId: lamp,
    name: 'mossy',
    displayName: 'Mossy',
    origin: 'manual',
    newId: newId(),
    now: TS,
  });
  await addFile(uuid(2), 'crate.blend', 'model');
  const moving = await addFile(uuid(1), 'blueprint.png');
  await db.fileMoves.begin({
    fileId: moving,
    kind: 'relocate',
    targetRelativePath: `assets/${uuid(3)}/${moving}.bin`,
    targetAssetId: uuid(3),
    targetRole: 'reference',
    createdAt: TS,
  });
  await db.fileMoves.commit(moving);
  await addFile(null, 'loose.png');
}

describe('derived-data step', () => {
  test('a missing stamp rebuilds the same index as the incremental path', async () => {
    await buildLibrary();
    const incremental = snapshot();
    expect(incremental).toHaveLength(3);
    setStamp(null);

    await db.ensureDerivedData();

    expect(snapshot()).toEqual(incremental);
    expect(stamp()).toBe(DERIVED_DATA_VERSION);
  });

  test('an outdated stamp rebuilds', async () => {
    await buildLibrary();
    const incremental = snapshot();
    setStamp(0);
    raw((s) => s.prepare('delete from asset_search').run());

    await db.ensureDerivedData();

    expect(snapshot()).toEqual(incremental);
    expect(stamp()).toBe(DERIVED_DATA_VERSION);
  });

  test('a current stamp does nothing', async () => {
    await buildLibrary();
    setStamp(DERIVED_DATA_VERSION);
    raw((s) =>
      s
        .prepare('delete from asset_search where rowid = (select rowid from asset_search_map where asset_id = ?)')
        .run(uuid(1)),
    );
    const before = snapshot();
    expect(before).toHaveLength(2);

    await db.ensureDerivedData();

    expect(snapshot()).toEqual(before);
  });

  test('file kinds are recomputed', async () => {
    await buildLibrary();
    raw((s) => s.prepare("update file set kind = 'other'").run());
    setStamp(null);

    await db.ensureDerivedData();

    expect(kinds()).toEqual([
      { n: 'blueprint.png', kind: 'image' },
      { n: 'crate.blend', kind: 'model' },
      { n: 'lamp.png', kind: 'image' },
      { n: 'loose.png', kind: 'image' },
    ]);
  });

  test('an existing video row gets kind video and its MIME type; no other row changes its MIME type', async () => {
    const video = await addFile(null, 'clip.mp4', 'other');
    const m4v = await addFile(null, 'clip.M4V', 'other');
    const webm = await addFile(null, 'clip.webm', 'other');
    const image = await addFile(null, 'photo.png');
    const text = await addFile(null, 'notes.txt', 'document');
    const hidden = await addFile(null, '.mp4', 'other');
    raw((s) => {
      s.prepare("update file set mime_type = 'image/png' where id = ?").run(image);
      s.prepare("update file set mime_type = 'text/x-own' where id = ?").run(text);
    });
    setStamp(1);

    await db.ensureDerivedData();

    const rows = raw((s) => s.prepare('select id, kind, mime_type as mimeType from file order by id').all());
    expect(rows).toEqual(
      [
        { id: video, kind: 'video', mimeType: 'video/mp4' },
        { id: m4v, kind: 'video', mimeType: 'video/mp4' },
        { id: webm, kind: 'video', mimeType: 'video/webm' },
        { id: image, kind: 'image', mimeType: 'image/png' },
        { id: text, kind: 'document', mimeType: 'text/x-own' },
        { id: hidden, kind: 'other', mimeType: 'application/octet-stream' },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    await expect(db.files.get(video)).resolves.toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      thumbnail: true,
      previewable: false,
    });
    expect(stamp()).toBe(DERIVED_DATA_VERSION);
  });

  test('an interrupted rebuild keeps the old stamp and completes on the next run', async () => {
    for (let n = 1; n <= 5; n++) {
      await db.assets.insert(asset(n, `Asset ${n}`));
      await addFile(uuid(n), `file${n}.png`);
    }
    const incremental = snapshot();
    expect(incremental).toHaveLength(5);
    await db.close();
    setStamp(null);

    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, {
      derivedData: {
        batchSize: 2,
        afterBatch(batchIndex) {
          if (batchIndex === 0) throw new Error('interrupted');
        },
      },
    });
    await expect(db.ensureDerivedData()).rejects.toThrow('interrupted');
    await db.close();
    expect(stamp()).toBeNull();

    db = await openFresh();
    await db.ensureDerivedData();
    expect(stamp()).toBe(DERIVED_DATA_VERSION);
    expect(snapshot()).toEqual(incremental);
  });

  test('the rebuild yields to the event loop between batches', async () => {
    for (let n = 1; n <= 5; n++) await db.assets.insert(asset(n, `Asset ${n}`));
    const incremental = snapshot();
    await db.close();
    setStamp(null);

    let immediates = 0;
    const seen: number[] = [];
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, {
      derivedData: { batchSize: 2, afterBatch: () => seen.push(immediates) },
    });
    const tick = () => {
      immediates++;
      if (immediates < 100) setImmediate(tick);
    };
    setImmediate(tick);
    await db.ensureDerivedData();

    expect(seen).toHaveLength(3);
    expect(seen[2]).toBeGreaterThan(seen[1]!);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
    expect(snapshot()).toEqual(incremental);
    expect(stamp()).toBe(DERIVED_DATA_VERSION);
  });
});

describe('stored tag cleaning', () => {
  const T0 = '2025-12-31T00:00:00.000Z';
  const NUL = String.fromCodePoint(0);
  const ZERO_WIDTH = String.fromCodePoint(0x200b);
  const BIDI = String.fromCodePoint(0x202e);
  const DIRTY_BRASS = `bra${ZERO_WIDTH}ss`;
  const tagAsset = (assetId: string, name: string, displayName: string, origin: 'manual' | 'ai', now = TS) =>
    db.tags.addToAsset({ assetId, name, displayName, origin, newId: newId(), now });
  const rows = <T>(query: string) => raw((s) => s.prepare(query).all() as T[]);

  /** Tags as older versions stored them: with control and format characters, one only of them, one unused. */
  async function buildDirtyTags(): Promise<{ file: string; prompt: string }> {
    await db.assets.insert(asset(1, 'Lantern'));
    await db.assets.insert(asset(2, 'Crate'));
    await tagAsset(uuid(1), 'brass', 'Brass', 'manual');
    await tagAsset(uuid(1), DIRTY_BRASS, `Bra${ZERO_WIDTH}ss`, 'ai', T0);
    await tagAsset(uuid(2), DIRTY_BRASS, `Bra${ZERO_WIDTH}ss`, 'manual');
    const file = await addFile(uuid(2), 'crate.png');
    const invisible = `${ZERO_WIDTH}${BIDI}${NUL}`;
    await db.tags.addToFile({
      fileId: file,
      name: invisible,
      displayName: invisible,
      origin: 'manual',
      newId: newId(),
      now: TS,
    });
    const prompt = newId();
    await db.prompts.create({
      id: prompt,
      title: 'P',
      titleKey: 'p',
      description: '',
      version: { id: newId(), content: 'x', variables: [] },
      now: TS,
    });
    await db.prompts.addTag({
      promptId: prompt,
      name: `mo${NUL}ss`,
      displayName: `Mo${NUL}ss`,
      newId: newId(),
      now: TS,
      max: 50,
    });
    await db.analyses.propose({
      fileId: file,
      sha256: 'a'.repeat(64),
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      tags: [
        { name: DIRTY_BRASS, displayName: `Bra${ZERO_WIDTH}ss` },
        { name: 'brass', displayName: 'brass' },
        { name: invisible, displayName: invisible },
        { name: 'iron', displayName: `Iron${BIDI}` },
      ],
      promptName: null,
      createdAt: TS,
    });
    raw((s) =>
      s
        .prepare('insert into tag (id, name, display_name, created_at) values (?, ?, ?, ?)')
        .run(newId(), 'unused', 'unused', TS),
    );
    return { file, prompt };
  }

  test('removes control and format characters, merges names that become equal and removes empty tags', async () => {
    const { file, prompt } = await buildDirtyTags();
    setStamp(2);

    await db.ensureDerivedData();

    expect(stamp()).toBe(DERIVED_DATA_VERSION);
    expect(rows('select name, display_name from tag order by name')).toEqual([
      { name: 'brass', display_name: 'Brass' },
      { name: 'moss', display_name: 'Moss' },
    ]);
    // Manual wins and the earlier link date is kept, as a merge by rename does.
    expect(await db.tags.listForAsset(uuid(1))).toEqual([{ name: 'brass', displayName: 'Brass', origin: 'manual' }]);
    const linkDates = raw((s) => s.prepare('select created_at from asset_tag where asset_id = ?').all(uuid(1)));
    expect(linkDates).toEqual([{ created_at: T0 }]);
    expect(await db.tags.listForAsset(uuid(2))).toEqual([{ name: 'brass', displayName: 'Brass', origin: 'manual' }]);
    expect((await db.files.get(file))!.tags).toEqual([]);
    expect((await db.prompts.get(prompt))!.tags).toEqual([{ name: 'moss', displayName: 'Moss', origin: 'manual' }]);
    expect((await db.analyses.getProposal(file))?.tags).toEqual([
      { name: 'brass', displayName: 'Brass' },
      { name: 'iron', displayName: 'Iron' },
    ]);
    const indexed = rows<{ asset_id: string; tags: string }>(SNAPSHOT_SQL).map((row) => [row.asset_id, row.tags]);
    expect(indexed).toEqual([
      [uuid(1), 'brass'],
      [uuid(2), 'brass'],
    ]);
  });

  test('a current stamp leaves the stored tags alone', async () => {
    await buildDirtyTags();
    setStamp(DERIVED_DATA_VERSION);
    const before = rows('select * from tag order by id');

    await db.ensureDerivedData();

    expect(rows('select * from tag order by id')).toEqual(before);
  });
});
