import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Asset, TagOrigin } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T1 = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextTagId = 5000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-tags-'));
  // Captures the connection that openWorkspaceDatabase creates (it calls `pragma` on it first).
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T1 });
  await db.assetTypes.insertMissing([
    { id: TYPE_ID, key: BUILT_IN_ASSET_TYPES[0]!.key, name: 'T', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
  ]);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function addAsset(n: number): Promise<Asset> {
  const a: Asset = { id: uuid(n), name: `A${n}`, typeId: TYPE_ID, description: '', status: 'draft', createdAt: T1, updatedAt: T1 };
  await db.assets.insert(a);
  return a;
}

async function addFile(n: number): Promise<string> {
  const id = uuid(n);
  await db.files.insertPending({
    id,
    storageId: STORAGE_ID,
    originalName: `f${n}.png`,
    relativePath: `inbox/${id}/f${n}.png`,
    mimeType: 'image/png',
    importedAt: T1,
    kind: 'image',
  });
  await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64) });
  return id;
}

const tagAsset = (assetId: string, name: string, origin: TagOrigin = 'manual', displayName = name) =>
  db.tags.addToAsset({ assetId, name, displayName, origin, newId: uuid(nextTagId++), now: T1 });
const tagFile = (fileId: string, name: string, origin: TagOrigin = 'manual', displayName = name) =>
  db.tags.addToFile({ fileId, name, displayName, origin, newId: uuid(nextTagId++), now: T1 });

describe('tag repository', () => {
  test('tag names are unique by normalised name', async () => {
    const a = await addAsset(10);
    const b = await addAsset(11);
    await tagAsset(a.id, 'sci fi', 'manual', 'Sci Fi');
    await tagAsset(b.id, 'sci fi', 'manual', 'SCI FI');
    expect(handle.prepare('select count(*) as n from tag').get()).toEqual({ n: 1 });
    expect(handle.prepare('select count(*) as n from asset_tag').get()).toEqual({ n: 2 });
    expect(await db.tags.listForAsset(b.id)).toEqual([{ name: 'sci fi', displayName: 'Sci Fi', origin: 'manual' }]);
  });

  test('adding an existing assignment is a no-op', async () => {
    const a = await addAsset(10);
    await tagAsset(a.id, 'x');
    await tagAsset(a.id, 'x');
    expect(await db.tags.listForAsset(a.id)).toHaveLength(1);
  });

  test('manual and ai assignments of one tag coexist and a delete by origin leaves the other', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'hero', 'manual');
    await tagAsset(a.id, 'hero', 'ai');
    await tagFile(f, 'hero', 'manual');
    await tagFile(f, 'hero', 'ai');
    expect((await db.tags.listForAsset(a.id)).map((t) => t.origin)).toEqual(['ai', 'manual']);

    await db.tags.removeFromAsset({ assetId: a.id, name: 'hero', origin: 'ai' });
    expect((await db.tags.listForAsset(a.id)).map((t) => t.origin)).toEqual(['manual']);
    await db.tags.removeFromAsset({ assetId: a.id, name: 'hero', origin: 'manual' });
    expect(await db.tags.listForAsset(a.id)).toEqual([]);

    await db.tags.removeFromFile({ fileId: f, name: 'hero', origin: 'manual' });
    expect((await db.files.get(f))!.tags.map((t) => t.origin)).toEqual(['ai']);
    await db.tags.removeFromFile({ fileId: f, name: 'hero', origin: 'ai' });
    expect((await db.files.get(f))!.tags).toEqual([]);
  });

  test('removing a missing tag or assignment is a no-op', async () => {
    const a = await addAsset(10);
    await db.tags.removeFromAsset({ assetId: a.id, name: 'nope', origin: 'manual' });
    await tagAsset(a.id, 'x');
    await db.tags.removeFromAsset({ assetId: a.id, name: 'x', origin: 'ai' });
    expect(await db.tags.listForAsset(a.id)).toHaveLength(1);
  });

  test('suggest uses the name index range and counts both owners', async () => {
    const a = await addAsset(10);
    const b = await addAsset(11);
    const f = await addFile(20);
    await tagAsset(a.id, 'sci fi', 'manual', 'Sci Fi');
    await tagAsset(b.id, 'sci fi');
    await tagFile(f, 'scenic');
    await tagFile(f, 'sci fi');
    await tagAsset(a.id, 'gone');
    await db.tags.removeFromAsset({ assetId: a.id, name: 'gone', origin: 'manual' });
    await tagAsset(a.id, 'other');

    expect(await db.tags.suggest({ prefix: 'sc', limit: 10 })).toEqual([
      { name: 'sci fi', displayName: 'Sci Fi' },
      { name: 'scenic', displayName: 'scenic' },
    ]);
    expect(await db.tags.suggest({ prefix: 'go', limit: 10 })).toEqual([]);
    expect(await db.tags.suggest({ prefix: 'sc', limit: 1 })).toHaveLength(1);
    expect((await db.tags.suggest({ prefix: '', limit: 10 })).map((t) => t.name)).toEqual(['sci fi', 'other', 'scenic']);
  });

  test('suggest treats LIKE wildcards and multi-byte prefixes literally', async () => {
    const a = await addAsset(10);
    const cafe = `caf${String.fromCodePoint(0xe9)}`;
    const smiley = String.fromCodePoint(0x1f600);
    await tagAsset(a.id, cafe);
    await tagAsset(a.id, `${cafe}s`);
    await tagAsset(a.id, 'cafz');
    await tagAsset(a.id, `${smiley}${smiley}`);
    await tagAsset(a.id, '100%');
    await tagAsset(a.id, '100x');
    expect((await db.tags.suggest({ prefix: cafe, limit: 10 })).map((t) => t.name)).toEqual([cafe, `${cafe}s`]);
    expect((await db.tags.suggest({ prefix: smiley, limit: 10 })).map((t) => t.name)).toEqual([`${smiley}${smiley}`]);
    expect((await db.tags.suggest({ prefix: '100%', limit: 10 })).map((t) => t.name)).toEqual(['100%']);
  });

  test('file records carry kind and tags', async () => {
    const f1 = await addFile(20);
    const f2 = await addFile(21);
    await db.files.insertPending({
      id: uuid(22),
      storageId: STORAGE_ID,
      originalName: 'scene.blend',
      relativePath: 'inbox/x/scene.blend',
      mimeType: 'application/octet-stream',
      importedAt: T1,
      kind: 'model',
    });
    await tagFile(f1, 'b');
    await tagFile(f1, 'a', 'ai');
    await tagFile(f1, 'a', 'manual');
    await tagFile(f2, 'c');

    const got = (await db.files.get(f1))!;
    expect(got.kind).toBe('image');
    expect(got.tags).toEqual([
      { name: 'a', displayName: 'a', origin: 'ai' },
      { name: 'a', displayName: 'a', origin: 'manual' },
      { name: 'b', displayName: 'b', origin: 'manual' },
    ]);
    const listed = (await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' } })).items;
    expect(listed.find((f) => f.id === f1)!.tags).toHaveLength(3);
    expect(listed.find((f) => f.id === f2)!.tags).toEqual([{ name: 'c', displayName: 'c', origin: 'manual' }]);
    const model = listed.find((f) => f.id === uuid(22))!;
    expect(model.kind).toBe('model');
    expect(model.tags).toEqual([]);
    expect((await db.files.listByStatus('complete')).find((f) => f.id === f2)!.tags).toHaveLength(1);
    expect((await db.files.findCompleteBySha256('a'.repeat(64))).find((f) => f.id === f1)!.tags).toHaveLength(3);
  });
});

describe('file tag batches', () => {
  const batch = (fileIds: string[], name = 'oak') => ({ fileIds, name, displayName: 'Oak', origin: 'manual' as const, now: T1 });
  const addMany = (fileIds: string[], name?: string) => db.tags.addToFiles({ ...batch(fileIds, name), newId: uuid(nextTagId++) });
  const removeMany = (fileIds: string[], name = 'oak', origin: TagOrigin = 'manual') => db.tags.removeFromFiles({ fileIds, name, origin });

  async function addPendingFile(n: number): Promise<string> {
    const id = uuid(n);
    await db.files.insertPending({
      id,
      storageId: STORAGE_ID,
      originalName: `p${n}.png`,
      relativePath: `inbox/${id}/p${n}.png`,
      mimeType: 'image/png',
      importedAt: T1,
      kind: 'image',
    });
    return id;
  }

  const place = (fileId: string, assetId: string) =>
    db.files.setPlacement(fileId, { relativePath: `assets/${assetId}/reference/${fileId}.png`, assetId, role: 'reference' });
  const counts = () => ({
    tags: handle.prepare('select count(*) as n from tag').get(),
    fileTags: handle.prepare('select count(*) as n from file_tag').get(),
  });

  test('addToFiles is all or nothing and returns the records in request order', async () => {
    const a = await addFile(20);
    const b = await addFile(21);
    const pending = await addPendingFile(22);
    const before = counts();

    await expect(addMany([a, pending])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addMany([a, uuid(999)])).rejects.toMatchObject({ code: 'not_found' });
    expect(counts()).toEqual(before); // neither the tag nor an assignment was written

    const records = await addMany([b, a]);
    expect(records.map((r) => r.id)).toEqual([b, a]);
    expect(records.map((r) => r.tags)).toEqual([
      [{ name: 'oak', displayName: 'Oak', origin: 'manual' }],
      [{ name: 'oak', displayName: 'Oak', origin: 'manual' }],
    ]);
    // Repeating the batch leaves the existing assignments alone.
    expect((await addMany([a])).map((r) => r.tags)).toHaveLength(1);
    expect(handle.prepare('select count(*) as n from file_tag').get()).toEqual({ n: 2 });
  });

  test('removeFromFiles is all or nothing, removes one origin and ignores files without the tag', async () => {
    const a = await addFile(20);
    const b = await addFile(21);
    const c = await addFile(22);
    const pending = await addPendingFile(23);
    await addMany([a, b]);
    await tagFile(a, 'oak', 'ai');

    await expect(removeMany([a, pending])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(removeMany([uuid(999), a])).rejects.toMatchObject({ code: 'not_found' });
    expect(handle.prepare('select count(*) as n from file_tag').get()).toEqual({ n: 3 });

    const records = await removeMany([c, a, b]);
    expect(records.map((r) => r.id)).toEqual([c, a, b]);
    expect(records.map((r) => r.tags.map((t) => t.origin))).toEqual([[], ['ai'], []]);
    expect((await removeMany([a], 'unknown')).map((r) => r.tags)).toHaveLength(1);
  });

  test('a tag batch over 300 files of one asset reindexes the asset once', async () => {
    // Spying on the `reindexAsset` export cannot see the calls made inside its own module, so the
    // writes of full-text rows are counted on the connection instead.
    const asset = await addAsset(10);
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = await addFile(100 + i);
      await place(id, asset.id);
      ids.push(id);
    }
    const inbox = await addFile(500);
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    const indexWrites = () => prepare.mock.calls.filter(([source]) => /^\s*insert into asset_search\b/i.test(String(source))).length;

    await addMany([...ids, inbox]);
    expect(indexWrites()).toBe(1);
    prepare.mockClear();
    await removeMany([...ids, inbox]);
    expect(indexWrites()).toBe(1);
  });

  test('a tagged asset file is found by assets:list query afterwards', async () => {
    const asset = await addAsset(10);
    await addAsset(11);
    const f = await addFile(20);
    await place(f, asset.id);

    await addMany([f], 'sci fi');
    const found = await db.assets.list({ limit: 10, offset: 0, query: 'sci' });
    expect(found.items.map((a) => a.id)).toEqual([asset.id]);

    await removeMany([f], 'sci fi');
    expect((await db.assets.list({ limit: 10, offset: 0, query: 'sci' })).items).toEqual([]);
  });
});
