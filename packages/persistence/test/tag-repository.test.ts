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
    {
      id: TYPE_ID,
      key: BUILT_IN_ASSET_TYPES[0]!.key,
      name: 'T',
      sortOrder: 0,
      builtIn: true,
      defaultWorkflowTemplateId: null,
    },
  ]);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function addAsset(n: number): Promise<Asset> {
  const a: Asset = {
    id: uuid(n),
    name: `A${n}`,
    typeId: TYPE_ID,
    description: '',
    status: 'draft',
    createdAt: T1,
    updatedAt: T1,
  };
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
  await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
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

  test('a manual add replaces an ai assignment and an ai add yields to any assignment', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'hero', 'ai');
    await tagFile(f, 'hero', 'ai');
    await tagAsset(a.id, 'hero', 'manual');
    await tagFile(f, 'hero', 'manual');
    expect((await db.tags.listForAsset(a.id)).map((t) => t.origin)).toEqual(['manual']);
    expect((await db.files.get(f))!.tags.map((t) => t.origin)).toEqual(['manual']);

    await tagAsset(a.id, 'hero', 'ai');
    await tagFile(f, 'hero', 'ai');
    expect((await db.tags.listForAsset(a.id)).map((t) => t.origin)).toEqual(['manual']);
    expect((await db.files.get(f))!.tags.map((t) => t.origin)).toEqual(['manual']);

    await tagAsset(a.id, 'solo', 'ai');
    await tagAsset(a.id, 'solo', 'ai');
    expect((await db.tags.listForAsset(a.id)).filter((t) => t.name === 'solo').map((t) => t.origin)).toEqual(['ai']);
  });

  test('a removal deletes the assignment whatever its origin', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'hero', 'ai');
    await tagFile(f, 'hero', 'ai');
    await db.tags.removeFromAsset({ assetId: a.id, name: 'hero' });
    expect(await db.tags.listForAsset(a.id)).toEqual([]);
    await db.tags.removeFromFile({ fileId: f, name: 'hero' });
    expect((await db.files.get(f))!.tags).toEqual([]);
  });

  test('removing a missing tag or assignment is a no-op', async () => {
    const a = await addAsset(10);
    await db.tags.removeFromAsset({ assetId: a.id, name: 'nope' });
    await tagAsset(a.id, 'x');
    await db.tags.removeFromAsset({ assetId: a.id, name: 'other' });
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
    await db.tags.removeFromAsset({ assetId: a.id, name: 'gone' });
    await tagAsset(a.id, 'other');

    expect(await db.tags.suggest({ prefix: 'sc', limit: 10 })).toEqual([
      { name: 'sci fi', displayName: 'Sci Fi' },
      { name: 'scenic', displayName: 'scenic' },
    ]);
    expect(await db.tags.suggest({ prefix: 'go', limit: 10 })).toEqual([]);
    expect(await db.tags.suggest({ prefix: 'sc', limit: 1 })).toHaveLength(1);
    expect((await db.tags.suggest({ prefix: '', limit: 10 })).map((t) => t.name)).toEqual([
      'sci fi',
      'other',
      'scenic',
    ]);
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
    await tagFile(f2, 'c');

    const got = (await db.files.get(f1))!;
    expect(got.kind).toBe('image');
    expect(got.tags).toEqual([
      { name: 'a', displayName: 'a', origin: 'ai' },
      { name: 'b', displayName: 'b', origin: 'manual' },
    ]);
    const listed = (await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' } })).items;
    expect(listed.find((f) => f.id === f1)!.tags).toHaveLength(2);
    expect(listed.find((f) => f.id === f2)!.tags).toEqual([{ name: 'c', displayName: 'c', origin: 'manual' }]);
    const model = listed.find((f) => f.id === uuid(22))!;
    expect(model.kind).toBe('model');
    expect(model.tags).toEqual([]);
    expect((await db.files.listByStatus('complete')).find((f) => f.id === f2)!.tags).toHaveLength(1);
    expect((await db.files.findCompleteBySha256('a'.repeat(64))).find((f) => f.id === f1)!.tags).toHaveLength(2);
  });
});

describe('file tag batches', () => {
  const batch = (fileIds: string[], name = 'oak') => ({
    fileIds,
    name,
    displayName: 'Oak',
    origin: 'manual' as const,
    now: T1,
  });
  const addMany = (fileIds: string[], name?: string) =>
    db.tags.addToFiles({ ...batch(fileIds, name), newId: uuid(nextTagId++) });
  const removeMany = (fileIds: string[], name = 'oak') => db.tags.removeFromFiles({ fileIds, name });

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
    db.files.setPlacement(fileId, {
      relativePath: `assets/${assetId}/reference/${fileId}.png`,
      assetId,
      role: 'reference',
    });
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
    expect((await addMany([a])).map((r) => r.tags)).toEqual([[{ name: 'oak', displayName: 'Oak', origin: 'manual' }]]);
    expect(handle.prepare('select count(*) as n from file_tag').get()).toEqual({ n: 2 });
  });

  test('a batch answers the first failure by kind, not by position: unknown, then incomplete', async () => {
    const a = await addFile(20);
    const pending = await addPendingFile(22);
    const before = counts();
    // The pending file comes first, yet the unknown one decides.
    await expect(addMany([pending, a, uuid(999)])).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeMany([pending, uuid(999)])).rejects.toMatchObject({ code: 'not_found' });
    expect(counts()).toEqual(before);
  });

  test('addToFiles lets manual win per file and ai yield', async () => {
    const a = await addFile(20);
    const b = await addFile(21);
    await tagFile(a, 'oak', 'ai');
    const records = await addMany([a, b]);
    expect(records.map((r) => r.tags.map((t) => t.origin))).toEqual([['manual'], ['manual']]);
    const again = await db.tags.addToFiles({ ...batch([a, b]), origin: 'ai', newId: uuid(nextTagId++) });
    expect(again.map((r) => r.tags.map((t) => t.origin))).toEqual([['manual'], ['manual']]);
  });

  test('removeFromFiles is all or nothing, removes any origin and ignores files without the tag', async () => {
    const a = await addFile(20);
    const b = await addFile(21);
    const c = await addFile(22);
    const pending = await addPendingFile(23);
    await tagFile(a, 'oak', 'ai');
    await addMany([b]);

    await expect(removeMany([a, pending])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(removeMany([uuid(999), a])).rejects.toMatchObject({ code: 'not_found' });
    expect(handle.prepare('select count(*) as n from file_tag').get()).toEqual({ n: 2 });

    const records = await removeMany([c, a, b]);
    expect(records.map((r) => r.id)).toEqual([c, a, b]);
    expect(records.map((r) => r.tags.map((t) => t.origin))).toEqual([[], [], []]);
    expect((await removeMany([a], 'unknown')).map((r) => r.tags)).toEqual([[]]);
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
    const indexWrites = () =>
      prepare.mock.calls.filter(([source]) => /^\s*insert into asset_search\b/i.test(String(source))).length;

    try {
      await addMany([...ids, inbox]);
      expect(indexWrites()).toBe(1);
      prepare.mockClear();
      await removeMany([...ids, inbox]);
      expect(indexWrites()).toBe(1);
    } finally {
      prepare.mockRestore();
    }
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

describe('tags of trashed files', () => {
  async function trash(fileId: string): Promise<void> {
    await db.fileMoves.begin({
      fileId,
      kind: 'trash',
      targetRelativePath: `.assetforge/trash/${fileId}_f.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T1,
    });
    await db.fileMoves.commit(fileId);
  }

  test('suggest does not count a trashed file', async () => {
    const a = await addAsset(10);
    const live = await addFile(20);
    const gone1 = await addFile(21);
    const gone2 = await addFile(22);
    await tagAsset(a.id, 'stone');
    await tagFile(gone1, 'steel');
    await tagFile(gone2, 'steel');
    await tagFile(gone1, 'stale'); // carried only by trashed files
    await tagFile(live, 'stale');
    await tagFile(gone2, 'stump');
    await trash(gone1);
    await trash(gone2);

    // steel has no live owner; stone and stale have one each; stump has none.
    expect(await db.tags.suggest({ prefix: 'st', limit: 10 })).toEqual([
      { name: 'stale', displayName: 'stale' },
      { name: 'stone', displayName: 'stone' },
    ]);
    await tagAsset(a.id, 'steel');
    expect((await db.tags.suggest({ prefix: 'ste', limit: 10 })).map((t) => t.name)).toEqual(['steel']);
  });

  test('batch tagging refuses a trashed file and tags none', async () => {
    const live = await addFile(20);
    const gone = await addFile(21);
    await tagFile(gone, 'oak');
    await trash(gone);
    const before = () => ({
      tags: handle.prepare('select count(*) as n from tag').get(),
      fileTags: handle.prepare('select file_id, origin from file_tag order by file_id').all(),
    });
    const snapshot = before();

    const add = db.tags.addToFiles({
      fileIds: [live, gone],
      name: 'pine',
      displayName: 'pine',
      origin: 'manual',
      newId: uuid(nextTagId++),
      now: T1,
    });
    await expect(add).rejects.toMatchObject({ code: 'invalid_operation', message: 'The file is in the trash' });
    await expect(db.tags.removeFromFiles({ fileIds: [gone, live], name: 'oak' })).rejects.toMatchObject({
      code: 'invalid_operation',
      message: 'The file is in the trash',
    });
    expect(before()).toEqual(snapshot);
  });
});

describe('tag usage and rename', () => {
  const T0 = '2025-12-31T00:00:00.000Z';
  const T2 = '2026-01-02T00:00:00.000Z';

  const tagAssetAt = (assetId: string, name: string, origin: TagOrigin, now: string, displayName = name) =>
    db.tags.addToAsset({ assetId, name, displayName, origin, newId: uuid(nextTagId++), now });
  const tagFileAt = (fileId: string, name: string, origin: TagOrigin, now: string, displayName = name) =>
    db.tags.addToFile({ fileId, name, displayName, origin, newId: uuid(nextTagId++), now });
  const tagRow = (name: string) =>
    handle.prepare('select * from tag where name = ?').get(name) as Record<string, unknown> | undefined;
  const assetLinks = () => handle.prepare('select * from asset_tag order by asset_id, tag_id, origin').all();
  const fileLinks = () => handle.prepare('select * from file_tag order by file_id, tag_id, origin').all();
  const dump = () => ({
    tag: handle.prepare('select * from tag order by id').all(),
    assetTag: assetLinks(),
    fileTag: fileLinks(),
    proposal: handle.prepare('select * from file_analysis_proposal order by file_id').all(),
    search: handle.prepare('select rowid, * from asset_search order by rowid').all(),
  });
  const place = (fileId: string, assetId: string) =>
    db.files.setPlacement(fileId, { relativePath: `assets/${assetId}/${fileId}.png`, assetId, role: 'reference' });

  async function trash(fileId: string): Promise<void> {
    await db.fileMoves.begin({
      fileId,
      kind: 'trash',
      targetRelativePath: `.assetforge/trash/${fileId}_f.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T1,
    });
    await db.fileMoves.commit(fileId);
  }

  test('usage counts assets carrying the tag and files not in the trash', async () => {
    const a = await addAsset(10);
    const b = await addAsset(11);
    const viaFile = await addAsset(12);
    const live = await addFile(20);
    const onAsset = await addFile(21);
    const gone = await addFile(22);
    await place(onAsset, viaFile.id);
    await tagAsset(a.id, 'front view', 'manual', 'Front View');
    await tagAsset(b.id, 'front view', 'ai');
    await tagFile(live, 'front view', 'ai');
    await tagFile(onAsset, 'front view');
    await tagFile(gone, 'front view');
    await trash(gone);
    // The asset tagged only through one of its files counts under files only.
    expect(await db.tags.usage('front view')).toEqual({ displayName: 'Front View', assets: 2, files: 2, prompts: 0 });
  });

  test('usage of a tag without links counts zero; of an unknown name it is null', async () => {
    // Only a row older versions left behind has no links.
    handle
      .prepare('insert into tag (id, name, display_name, created_at) values (?, ?, ?, ?)')
      .run(uuid(nextTagId++), 'lonely', 'Lonely', T1);
    expect(await db.tags.usage('lonely')).toEqual({ displayName: 'Lonely', assets: 0, files: 0, prompts: 0 });
    expect(await db.tags.usage('unknown')).toBeNull();
  });

  test('rename of an unknown tag throws not_found', async () => {
    await expect(db.tags.rename({ from: 'nope', name: 'x', displayName: 'x', merge: true })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Tag does not exist',
    });
  });

  test('rename to a free name keeps the tag row and leaves the links alone', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'front view', 'manual', 'Front View');
    await tagFile(f, 'front view', 'ai', 'Front View');
    const before = tagRow('front view')!;
    const links = { asset: assetLinks(), file: fileLinks() };

    expect(await db.tags.rename({ from: 'front view', name: 'frontal', displayName: 'Frontal', merge: false })).toEqual(
      { merged: false },
    );
    expect(tagRow('front view')).toBeUndefined();
    expect(tagRow('frontal')).toEqual({ ...before, name: 'frontal', display_name: 'Frontal' });
    expect({ asset: assetLinks(), file: fileLinks() }).toEqual(links);
    expect(await db.tags.listForAsset(a.id)).toEqual([{ name: 'frontal', displayName: 'Frontal', origin: 'manual' }]);
    expect((await db.files.get(f))!.tags).toEqual([{ name: 'frontal', displayName: 'Frontal', origin: 'ai' }]);
  });

  test.each([false, true])('rename to the same name changes only the display name (merge %s)', async (merge) => {
    const a = await addAsset(10);
    await tagAsset(a.id, 'front', 'manual', 'front');
    const before = dump();
    const row = tagRow('front')!;
    expect(await db.tags.rename({ from: 'front', name: 'front', displayName: 'FRONT', merge })).toEqual({
      merged: false,
    });
    expect(tagRow('front')).toEqual({ ...row, display_name: 'FRONT' });
    expect({ ...dump(), tag: before.tag }).toEqual(before);

    // An identical display name writes nothing.
    const changes = () => (handle.prepare('select total_changes() as n').get() as { n: number }).n;
    const written = changes();
    const same = dump();
    expect(await db.tags.rename({ from: 'front', name: 'front', displayName: 'FRONT', merge })).toEqual({
      merged: false,
    });
    expect(dump()).toEqual(same);
    expect(changes()).toBe(written);
  });

  // [source origin, target origin, expected origin]; null: the owner does not carry that tag.
  const cases: [TagOrigin | null, TagOrigin | null, TagOrigin][] = [
    ['ai', 'manual', 'manual'],
    ['manual', 'ai', 'manual'],
    ['ai', 'ai', 'ai'],
    ['manual', 'manual', 'manual'],
    ['ai', null, 'ai'],
    [null, 'manual', 'manual'],
  ];
  // The source is older on even owners, the target on odd ones.
  const sourceAt = (i: number) => (i % 2 === 0 ? T0 : T2);
  const targetAt = (i: number) => (i % 2 === 0 ? T2 : T0);
  // Both: the earlier one; one of them: its own.
  const expectedAt = (i: number, source: TagOrigin | null, target: TagOrigin | null) =>
    source && target ? T0 : source ? sourceAt(i) : targetAt(i);

  test('a merge leaves every file with one link to the target, manual when either was', async () => {
    const files: string[] = [];
    for (const [i, [source, target]] of cases.entries()) {
      const f = await addFile(20 + i);
      files.push(f);
      if (source) await tagFileAt(f, 'front view', source, sourceAt(i), 'Front View');
      if (target) await tagFileAt(f, 'front', target, targetAt(i), 'Front');
    }
    const target = tagRow('front')!;
    expect(await db.tags.rename({ from: 'front view', name: 'front', displayName: 'FRONT', merge: true })).toEqual({
      merged: true,
    });
    expect(tagRow('front view')).toBeUndefined();
    expect(tagRow('front')).toEqual({ ...target, display_name: 'FRONT' });
    expect(fileLinks()).toEqual(
      cases.map(([source, targetOrigin, expected], i) => ({
        file_id: files[i],
        tag_id: target.id,
        origin: expected,
        created_at: expectedAt(i, source, targetOrigin),
      })),
    );
  });

  test('a merge leaves every asset with one link to the target, manual when either was', async () => {
    const assets: string[] = [];
    for (const [i, [source, target]] of cases.entries()) {
      const a = await addAsset(10 + i);
      assets.push(a.id);
      if (source) await tagAssetAt(a.id, 'front view', source, sourceAt(i), 'Front View');
      if (target) await tagAssetAt(a.id, 'front', target, targetAt(i), 'Front');
    }
    const target = tagRow('front')!;
    expect(await db.tags.rename({ from: 'front view', name: 'front', displayName: 'FRONT', merge: true })).toEqual({
      merged: true,
    });
    expect(tagRow('front view')).toBeUndefined();
    expect(tagRow('front')).toEqual({ ...target, display_name: 'FRONT' });
    expect(assetLinks()).toEqual(
      cases.map(([source, targetOrigin, expected], i) => ({
        asset_id: assets[i],
        tag_id: target.id,
        origin: expected,
        created_at: expectedAt(i, source, targetOrigin),
      })),
    );
  });

  test('a file in the trash is merged too and carries the new name after a restore', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await place(f, a.id);
    await tagFile(f, 'front view', 'manual');
    await tagAsset(a.id, 'front', 'ai');
    await trash(f);
    expect(await db.tags.rename({ from: 'front view', name: 'front', displayName: 'Front', merge: true })).toEqual({
      merged: true,
    });
    await db.fileMoves.begin({
      fileId: f,
      kind: 'restore',
      targetRelativePath: `assets/${a.id}/${f}.png`,
      targetAssetId: a.id,
      targetRole: 'reference',
      createdAt: T2,
    });
    await db.fileMoves.commit(f);
    expect((await db.files.get(f))!.tags).toEqual([{ name: 'front', displayName: 'Front', origin: 'manual' }]);
  });

  test('a merge without merge true throws and writes nothing', async () => {
    const a = await addAsset(10);
    const b = await addAsset(11);
    const f = await addFile(20);
    await place(f, a.id);
    await tagAsset(a.id, 'front view', 'ai');
    await tagAsset(b.id, 'front', 'manual');
    await tagFile(f, 'front view', 'manual');
    await tagFile(f, 'front', 'ai');
    await db.analyses.propose({
      fileId: f,
      sha256: 'a'.repeat(64),
      provider: 'ollama',
      model: 'm',
      promptVersion: 1,
      promptName: 'Default',
      tags: [{ name: 'front view', displayName: 'Front View' }],
      createdAt: T1,
    });
    const before = dump();
    await expect(
      db.tags.rename({ from: 'front view', name: 'front', displayName: 'Front', merge: false }),
    ).rejects.toMatchObject({
      code: 'invalid_operation',
      message: 'A tag with this name already exists',
    });
    expect(dump()).toEqual(before);
  });

  test('a merge succeeds when the source or the target has no links', async () => {
    const a = await addAsset(10);
    // Only rows older versions left behind have no links.
    const legacyRow = (name: string) =>
      handle
        .prepare('insert into tag (id, name, display_name, created_at) values (?, ?, ?, ?)')
        .run(uuid(nextTagId++), name, name, T1);
    legacyRow('empty source');
    await tagAsset(a.id, 'front');
    expect(await db.tags.rename({ from: 'empty source', name: 'front', displayName: 'front', merge: true })).toEqual({
      merged: true,
    });
    expect(tagRow('empty source')).toBeUndefined();
    expect(await db.tags.listForAsset(a.id)).toEqual([{ name: 'front', displayName: 'front', origin: 'manual' }]);

    legacyRow('empty target');
    expect(
      await db.tags.rename({ from: 'front', name: 'empty target', displayName: 'Empty Target', merge: true }),
    ).toEqual({ merged: true });
    expect(tagRow('front')).toBeUndefined();
    expect(await db.tags.listForAsset(a.id)).toEqual([
      { name: 'empty target', displayName: 'Empty Target', origin: 'manual' },
    ]);
  });

  test('a merge over 3000 files, 1500 of them carrying both tags, succeeds', async () => {
    // Guards the bound-parameter limit: the merge must not list owner ids in the statement.
    const template = await addFile(20);
    await tagFile(template, 'front view', 'manual');
    await tagFile(template, 'front', 'ai');
    const source = tagRow('front view')!.id as string;
    const target = tagRow('front')!.id as string;
    const row = handle.prepare('select * from file where id = ?').get(template) as Record<string, unknown>;
    const columns = Object.keys(row);
    const insertFile = handle.prepare(
      `insert into file (${columns.join(', ')}) values (${columns.map((c) => `@${c}`).join(', ')})`,
    );
    const insertLink = handle.prepare('insert into file_tag (file_id, tag_id, origin, created_at) values (?, ?, ?, ?)');
    handle.transaction(() => {
      for (let i = 1; i < 3000; i++) {
        const id = uuid(100000 + i);
        insertFile.run({ ...row, id, relative_path: `inbox/${id}/f.png` });
        insertLink.run(id, source, 'manual', T1);
        if (i < 1500) insertLink.run(id, target, 'ai', T1);
      }
    })();

    expect(await db.tags.rename({ from: 'front view', name: 'front', displayName: 'front', merge: true })).toEqual({
      merged: true,
    });
    expect(
      handle
        .prepare('select count(*) as n, count(distinct file_id) as files from file_tag where tag_id = ?')
        .get(target),
    ).toEqual({
      n: 3000,
      files: 3000,
    });
    expect(handle.prepare("select count(*) as n from file_tag where origin = 'manual'").get()).toEqual({ n: 3000 });
    expect(tagRow('front view')).toBeUndefined();
  });
});

describe('prompt tags', () => {
  const T0 = '2025-12-31T00:00:00.000Z';
  const T2 = '2026-01-02T00:00:00.000Z';
  const PROMPT_UPDATED = '2025-06-01T00:00:00.000Z';

  async function addPrompt(n: number): Promise<string> {
    const id = uuid(n);
    await db.prompts.create({
      id,
      title: `P${n}`,
      titleKey: `p${n}`,
      description: '',
      version: { id: uuid(n + 1000), content: 'x', variables: [] },
      now: T0,
    });
    return id;
  }
  const tagPrompt = (promptId: string, name: string, now: string, displayName = name) =>
    db.prompts.addTag({ promptId, name, displayName, newId: uuid(nextTagId++), now, max: 50 });
  const tagRow = (name: string) =>
    handle.prepare('select * from tag where name = ?').get(name) as Record<string, unknown> | undefined;
  const promptLinks = () => handle.prepare('select * from prompt_tag order by prompt_id, tag_id').all();
  const promptUpdatedAt = () => handle.prepare('select id, updated_at from prompt order by id').all();

  test('suggest returns a tag that only a prompt carries', async () => {
    const p = await addPrompt(30);
    const a = await addAsset(10);
    await tagPrompt(p, 'storm', T1, 'Storm');
    await tagAsset(a.id, 'stone');
    await tagAsset(a.id, 'storm');
    expect(await db.tags.suggest({ prefix: 'st', limit: 10 })).toEqual([
      { name: 'storm', displayName: 'Storm' },
      { name: 'stone', displayName: 'stone' },
    ]);
  });

  test('usage counts the prompts carrying the tag', async () => {
    const a = await addAsset(10);
    await tagAsset(a.id, 'storm');
    await tagPrompt(await addPrompt(30), 'storm', T1);
    await tagPrompt(await addPrompt(31), 'storm', T1);
    expect(await db.tags.usage('storm')).toEqual({ displayName: 'storm', assets: 1, files: 0, prompts: 2 });
  });

  test('rename to a free name keeps the prompt link and the prompt updated_at', async () => {
    const p = await addPrompt(30);
    await tagPrompt(p, 'storm', T1);
    handle.prepare('update prompt set updated_at = ?').run(PROMPT_UPDATED);
    const links = promptLinks();
    expect(await db.tags.rename({ from: 'storm', name: 'tempest', displayName: 'Tempest', merge: false })).toEqual({
      merged: false,
    });
    expect(promptLinks()).toEqual(links);
    expect((await db.prompts.get(p))!.tags).toEqual([{ name: 'tempest', displayName: 'Tempest', origin: 'manual' }]);
    expect(promptUpdatedAt()).toEqual([{ id: p, updated_at: PROMPT_UPDATED }]);
  });

  test('a merge leaves each prompt one link to the kept tag with the earlier created_at', async () => {
    const both = await addPrompt(30); // source older
    const sourceOnly = await addPrompt(31);
    const bothTargetOlder = await addPrompt(32);
    await tagPrompt(both, 'front view', T0);
    await tagPrompt(both, 'front', T2);
    await tagPrompt(sourceOnly, 'front view', T2);
    await tagPrompt(bothTargetOlder, 'front view', T2);
    await tagPrompt(bothTargetOlder, 'front', T0);
    handle.prepare('update prompt set updated_at = ?').run(PROMPT_UPDATED);
    const target = tagRow('front')!;

    expect(await db.tags.rename({ from: 'front view', name: 'front', displayName: 'Front', merge: true })).toEqual({
      merged: true,
    });
    expect(tagRow('front view')).toBeUndefined();
    expect(promptLinks()).toEqual([
      { prompt_id: both, tag_id: target.id, created_at: T0 },
      { prompt_id: sourceOnly, tag_id: target.id, created_at: T2 },
      { prompt_id: bothTargetOlder, tag_id: target.id, created_at: T0 },
    ]);
    expect(promptUpdatedAt()).toEqual(
      [both, sourceOnly, bothTargetOlder].map((id) => ({ id, updated_at: PROMPT_UPDATED })),
    );
  });
});

describe('unused tag rows', () => {
  const SHA = 'a'.repeat(64);
  const tagNames = () =>
    (handle.prepare('select name from tag order by name').all() as { name: string }[]).map((row) => row.name);
  const tagIdOf = (name: string) =>
    (handle.prepare('select id from tag where name = ?').get(name) as { id: string } | undefined)?.id;
  const typed = (name: string) => ({ name, displayName: name, newId: uuid(nextTagId++) });
  const applyTags = (fileId: string, names: string[]) =>
    db.analyses.apply({
      fileId,
      sha256: SHA,
      tags: names.map(typed),
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      promptName: null,
      now: T1,
    });
  /** Inserts a row without links, as older versions left behind. */
  const legacyRow = (name: string) =>
    handle
      .prepare('insert into tag (id, name, display_name, created_at) values (?, ?, ?, ?)')
      .run(uuid(nextTagId++), name, name, T1);

  test('removing the last asset or file link deletes the row; a row still linked stays', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'shared');
    await tagFile(f, 'shared');
    await tagAsset(a.id, 'asset only');
    await tagFile(f, 'file only');
    await db.tags.removeFromAsset({ assetId: a.id, name: 'asset only' });
    await db.tags.removeFromFile({ fileId: f, name: 'file only' });
    await db.tags.removeFromAsset({ assetId: a.id, name: 'shared' });
    expect(tagNames()).toEqual(['shared']);
    await db.tags.removeFromFile({ fileId: f, name: 'shared' });
    expect(tagNames()).toEqual([]);
    expect(await db.tags.usage('shared')).toBeNull();
  });

  test('a batch removal deletes the rows it left without links', async () => {
    const f = await addFile(20);
    const g = await addFile(21);
    const request = { name: 'batch', displayName: 'batch', origin: 'manual' as const, now: T1 };
    await db.tags.addToFiles({ ...request, fileIds: [f, g], newId: uuid(nextTagId++) });
    await db.tags.removeFromFiles({ fileIds: [f], name: 'batch' });
    expect(tagNames()).toEqual(['batch']);
    await db.tags.removeFromFiles({ fileIds: [g], name: 'batch' });
    expect(tagNames()).toEqual([]);
  });

  test('a new analysis deletes the ai tags it no longer names and keeps the row of a tag named again', async () => {
    const f = await addFile(20);
    await applyTags(f, ['rusty', 'metal']);
    const metal = tagIdOf('metal');
    await applyTags(f, ['metal', 'old']);
    expect(tagNames()).toEqual(['metal', 'old']);
    expect(tagIdOf('metal')).toBe(metal);
  });

  test('a purge deletes the rows only the purged file used', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'kept');
    await tagFile(f, 'kept');
    await tagFile(f, 'gone');
    handle.prepare("update file set status = 'failed' where id = ?").run(f);
    expect(await db.files.purge(f, T1)).toBe(true);
    expect(tagNames()).toEqual(['kept']);
  });

  test('removing a prompt tag or deleting the prompt deletes the rows it left without links', async () => {
    const addPrompt = async (n: number) => {
      await db.prompts.create({
        id: uuid(n),
        title: `P${n}`,
        titleKey: `p${n}`,
        description: '',
        version: { id: uuid(n + 1000), content: 'x', variables: [] },
        now: T1,
      });
      return uuid(n);
    };
    const tagPrompt = (promptId: string, name: string) =>
      db.prompts.addTag({ promptId, name, displayName: name, newId: uuid(nextTagId++), now: T1, max: 50 });
    const p = await addPrompt(30);
    const q = await addPrompt(31);
    await tagPrompt(p, 'removed');
    await tagPrompt(p, 'deleted');
    await tagPrompt(p, 'shared');
    await tagPrompt(q, 'shared');
    await db.prompts.removeTag({ promptId: p, name: 'removed', now: T1 });
    expect(tagNames()).toEqual(['deleted', 'shared']);
    expect(await db.prompts.remove(p)).toBe(true);
    expect(tagNames()).toEqual(['shared']);
  });

  test('a rename or merge leaves no row without links', async () => {
    const a = await addAsset(10);
    legacyRow('empty');
    const renamed = await db.tags.rename({ from: 'empty', name: 'still empty', displayName: 'Still', merge: false });
    expect(renamed).toEqual({ merged: false });
    legacyRow('empty source');
    legacyRow('empty target');
    const merged = await db.tags.rename({ from: 'empty source', name: 'empty target', displayName: 'x', merge: true });
    expect(merged).toEqual({ merged: true });
    await tagAsset(a.id, 'front');
    expect(tagNames()).toEqual(['front']);
  });

  test('a waiting proposal keeps naming a tag whose row went and is accepted as before', async () => {
    const a = await addAsset(10);
    const f = await addFile(20);
    await tagAsset(a.id, 'rusty');
    await db.analyses.propose({
      fileId: f,
      sha256: SHA,
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      tags: [{ name: 'rusty', displayName: 'Rusty' }],
      promptName: null,
      createdAt: T1,
    });
    await db.tags.removeFromAsset({ assetId: a.id, name: 'rusty' });
    expect(tagNames()).toEqual([]);
    expect((await db.analyses.getProposal(f))?.tags).toEqual([{ name: 'rusty', displayName: 'Rusty' }]);
    const accepted = await db.analyses.acceptProposal({
      fileId: f,
      sha256: SHA,
      createdAt: T1,
      tags: [typed('rusty')],
      now: T1,
    });
    expect(accepted).toBe('accepted');
    expect((await db.files.get(f))!.tags).toEqual([{ name: 'rusty', displayName: 'rusty', origin: 'ai' }]);
  });
});
