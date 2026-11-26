import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetSummary, AssetType, FileKind, FileRole } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, recoverFileMoves, type Storage, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE = uuid(900);
const TYPE = uuid(100);
const OTHER_TYPE = uuid(101);

let dir: string;
let db: WorkspaceDatabase;
let nextId: number;
const newId = () => uuid(nextId++);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-search-'));
  db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
  nextId = 5000;
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

/** Names of the assets the query finds, in result order. */
const found = async (query: string, q: Partial<Parameters<WorkspaceDatabase['assets']['list']>[0]> = {}) =>
  (await db.assets.list({ limit: 50, offset: 0, query, ...q })).items.map((a) => a.name);

/** Inserts an inbox file in the given state and returns its id. */
const addInboxFile = async (originalName: string, status: 'complete' | 'pending' | 'failed' = 'complete', kind: FileKind = 'image') => {
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
  if (status === 'complete') await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
  if (status === 'failed') await db.files.markFailed(id, 'x');
  return id;
};

const place = (fileId: string, assetId: string | null, role: FileRole | null = 'reference') =>
  db.files.setPlacement(fileId, {
    relativePath: assetId === null ? `inbox/${fileId}.bin` : `assets/${assetId}/${fileId}.bin`,
    assetId,
    role: assetId === null ? null : role,
  });

const addFile = async (assetId: string, originalName: string, role: FileRole = 'reference', kind: FileKind = 'image') => {
  const id = await addInboxFile(originalName, 'complete', kind);
  await place(id, assetId, role);
  return id;
};

const tagAsset = (assetId: string, name: string) =>
  db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
const untagAsset = (assetId: string, name: string) => db.tags.removeFromAsset({ assetId, name });
const tagFile = (fileId: string, name: string) =>
  db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
const untagFile = (fileId: string, name: string) => db.tags.removeFromFile({ fileId, name });

describe('search index triggers', () => {
  test('asset insert and update reindex', async () => {
    await expect(found('lantern')).resolves.toEqual([]);
    await db.assets.insert(asset(1, 'Lantern'));
    await expect(found('lantern')).resolves.toEqual(['Lantern']);

    await db.assets.update(uuid(1), { name: 'Torch', updatedAt: TS });
    await expect(found('lantern')).resolves.toEqual([]);
    await expect(found('torch')).resolves.toEqual(['Torch']);

    await expect(found('glowing')).resolves.toEqual([]);
    await db.assets.update(uuid(1), { description: 'A glowing light', updatedAt: TS });
    await expect(found('glowing')).resolves.toEqual(['Torch']);
    await db.assets.update(uuid(1), { description: 'Dark', updatedAt: TS });
    await expect(found('glowing')).resolves.toEqual([]);
    await expect(found('dark')).resolves.toEqual(['Torch']);
  });

  test('asset tag add and remove reindex', async () => {
    await db.assets.insert(asset(1, 'Crate'));
    await expect(found('wooden')).resolves.toEqual([]);
    await tagAsset(uuid(1), 'wooden');
    await expect(found('wooden')).resolves.toEqual(['Crate']);
    await untagAsset(uuid(1), 'wooden');
    await expect(found('wooden')).resolves.toEqual([]);
  });

  test('file tag on an asset file reindexes; on an inbox file it does not fail', async () => {
    await db.assets.insert(asset(1, 'Crate'));
    const onAsset = await addFile(uuid(1), 'crate.png');
    await tagFile(onAsset, 'mossy');
    await expect(found('mossy')).resolves.toEqual(['Crate']);
    await untagFile(onAsset, 'mossy');
    await expect(found('mossy')).resolves.toEqual([]);

    const inbox = await addInboxFile('loose.png');
    await expect(tagFile(inbox, 'rusty')).resolves.toBeUndefined();
    await expect(found('rusty')).resolves.toEqual([]);
    await place(inbox, uuid(1));
    await expect(found('rusty')).resolves.toEqual(['Crate']);
    await expect(untagFile(inbox, 'nope')).resolves.toBeUndefined();
  });

  test('placement change reindexes the asset left and the asset joined', async () => {
    await db.assets.insert(asset(1, 'Alpha'));
    await db.assets.insert(asset(2, 'Bravo'));
    const id = await addFile(uuid(1), 'blueprint.png');
    await tagFile(id, 'schematic');
    await expect(found('blueprint')).resolves.toEqual(['Alpha']);
    await expect(found('schematic')).resolves.toEqual(['Alpha']);

    await place(id, uuid(2));
    await expect(found('blueprint')).resolves.toEqual(['Bravo']);
    await expect(found('schematic')).resolves.toEqual(['Bravo']);

    // Same asset, other role: still found once.
    await place(id, uuid(2), 'concept');
    await expect(found('blueprint')).resolves.toEqual(['Bravo']);

    await place(id, null);
    await expect(found('blueprint')).resolves.toEqual([]);
    await expect(found('schematic')).resolves.toEqual([]);
  });

  test('a committed file move reindexes both assets', async () => {
    await db.assets.insert(asset(1, 'Alpha'));
    await db.assets.insert(asset(2, 'Bravo'));
    const target = (fileId: string) => ({
      fileId,
      kind: 'relocate' as const,
      targetRelativePath: `assets/${uuid(2)}/${fileId}.bin`,
      targetAssetId: uuid(2),
      targetRole: 'reference' as const,
      createdAt: TS,
    });

    const first = await addFile(uuid(1), 'blueprint.png');
    await tagFile(first, 'schematic');
    await db.fileMoves.begin(target(first));
    await expect(found('blueprint')).resolves.toEqual(['Alpha']);
    await db.fileMoves.commit(first);
    await expect(found('blueprint')).resolves.toEqual(['Bravo']);
    await expect(found('schematic')).resolves.toEqual(['Bravo']);

    // Repair on open: the bytes already moved, the intent is still open.
    const second = await addFile(uuid(1), 'drawing.png');
    await db.fileMoves.begin(target(second));
    await expect(found('drawing')).resolves.toEqual(['Alpha']);
    const storage = { exists: async (path: string) => path === target(second).targetRelativePath } as unknown as Storage;
    const result = await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });
    expect(result.completed).toEqual([second]);
    await expect(found('drawing')).resolves.toEqual(['Bravo']);
  });

  test('only complete files contribute', async () => {
    await db.assets.insert(asset(1, 'Crate'));
    const pending = await addInboxFile('pallet.png', 'pending');
    await place(pending, uuid(1));
    await expect(found('pallet')).resolves.toEqual([]);
    await db.files.markComplete(pending, { sizeBytes: 1, sha256: 'b'.repeat(64), width: null, height: null });
    await expect(found('pallet')).resolves.toEqual(['Crate']);

    const failing = await addInboxFile('barrel.png', 'pending');
    await place(failing, uuid(1));
    await db.files.markFailed(failing, 'x');
    await expect(found('barrel')).resolves.toEqual([]);
  });

  test('a rename and a merge reindex the assets tagged themselves and through a complete file', async () => {
    await db.assets.insert(asset(1, 'Crate'));
    await db.assets.insert(asset(2, 'Barrel'));
    await db.assets.insert(asset(3, 'Chest'));
    await tagAsset(uuid(1), 'mossy');
    await tagFile(await addFile(uuid(2), 'barrel.png'), 'mossy');
    await tagAsset(uuid(3), 'weathered');
    const sorted = async (query: string) => (await found(query)).sort();
    await expect(sorted('mossy')).resolves.toEqual(['Barrel', 'Crate']);

    await db.tags.rename({ from: 'mossy', name: 'lichen', displayName: 'Lichen', merge: false });
    await expect(sorted('mossy')).resolves.toEqual([]);
    await expect(sorted('lichen')).resolves.toEqual(['Barrel', 'Crate']);

    await db.tags.rename({ from: 'lichen', name: 'weathered', displayName: 'Weathered', merge: true });
    await expect(sorted('lichen')).resolves.toEqual([]);
    await expect(sorted('weathered')).resolves.toEqual(['Barrel', 'Chest', 'Crate']);
  });
});

describe('search queries', () => {
  test('hostile query strings neither throw nor match wrongly', async () => {
    await db.assets.insert(asset(1, 'Nearby'));
    await db.assets.insert(asset(2, 'Far'));
    await db.assets.insert(asset(3, 'a b'));
    await db.assets.insert(asset(4, 'and or not'));
    await db.assets.insert(asset(5, 'x'.repeat(200)));
    const all = ['a b', 'and or not', 'Far', 'Nearby', 'x'.repeat(200)];

    for (const punctuation of ['"', '*', '-', '"*-:()^']) {
      await expect(found(punctuation)).resolves.toEqual(all);
    }
    await expect(found('NEAR')).resolves.toEqual(['Nearby']);
    await expect(found('a:b')).resolves.toEqual(await found('a b'));
    await expect(found('a:b')).resolves.toContain('a b');
    await expect(found('x'.repeat(200))).resolves.toEqual(['x'.repeat(200)]);
    await expect(found('AND OR NOT')).resolves.toEqual(['and or not']);
    // A run of combining marks alone is no word, so the query behaves like no query.
    await expect(found('́')).resolves.toEqual(all);
  });

  test('an emoji with a variation selector does not empty the search', async () => {
    await db.assets.insert(asset(1, 'Sword'));
    await db.assets.insert(asset(2, 'Shield'));
    await expect(found('sword')).resolves.toEqual(['Sword']);
    await expect(found('sword ⚔️')).resolves.toEqual(['Sword']);
    await expect(found('⚔️')).resolves.toEqual(['Shield', 'Sword']);
  });

  test('decomposed (NFD) names and file names are found by a composed query', async () => {
    const hangul = '한글';
    const kana = 'がぎ';
    expect(hangul.normalize('NFD')).not.toBe(hangul);
    expect(kana.normalize('NFD')).not.toBe(kana);
    await db.assets.insert(asset(1, hangul.normalize('NFD')));
    await db.assets.insert(asset(2, 'Other'));
    await addFile(uuid(2), `${kana.normalize('NFD')}.png`);
    await expect(found(hangul)).resolves.toEqual([hangul.normalize('NFD')]);
    await expect(found(kana)).resolves.toEqual(['Other']);
  });

  test('diacritics and case are folded', async () => {
    await db.assets.insert(asset(1, 'Café'));
    await db.assets.insert(asset(2, 'Cafe'));
    await db.assets.insert(asset(3, 'Tea'));
    for (const query of ['cafe', 'CAFÉ', 'café']) {
      await expect(found(query)).resolves.toEqual(['Cafe', 'Café']);
    }
  });

  test('prefix matching', async () => {
    await db.assets.insert(asset(1, 'Sword'));
    await db.assets.insert(asset(2, 'Shield'));
    await db.assets.insert(asset(3, 'Ray gun'));
    await tagAsset(uuid(3), 'sci-fi');
    await expect(found('sw')).resolves.toEqual(['Sword']);
    await expect(found('swo')).resolves.toEqual(['Sword']);
    await expect(found('ord')).resolves.toEqual([]);
    await expect(found('sci-fi')).resolves.toEqual(['Ray gun']);
  });

  test('ranking puts a name match before a description match', async () => {
    await db.assets.insert(asset(1, 'Alpha', { description: 'sword' }));
    await db.assets.insert(asset(2, 'Zulu sword'));
    await db.assets.insert(asset(3, 'Bravo'));
    await expect(found('sword')).resolves.toEqual(['Zulu sword', 'Alpha']);
  });

  test('search combines with every filter', async () => {
    await db.projects.insert({ id: uuid(800), name: 'Game', description: '', status: 'active', createdAt: TS, updatedAt: TS });
    const member = async (n: number) =>
      db.projectAssets.insert({
        projectId: uuid(800),
        assetId: uuid(n),
        priority: 'normal',
        intendedUse: '',
        approvalStatus: 'pending',
        notes: '',
        assignedAt: TS,
        updatedAt: TS,
      });
    // 1-5 match every filter; 6-10 each miss exactly one; 11 misses the words.
    const full = async (n: number, name: string) => {
      await db.assets.insert(asset(n, name, { status: 'completed' }));
      await member(n);
      await tagAsset(uuid(n), 'metal');
      await tagFile(await addFile(uuid(n), 'x.png', 'working', 'model'), 'rusty');
    };
    for (const [n, name] of [
      [1, 'Iron sword A'],
      [2, 'Iron sword B'],
      [3, 'Iron sword C'],
      [4, 'Iron sword D'],
      [5, 'Iron sword E'],
    ] as const) {
      await full(n, name);
    }
    await full(11, 'Copper sword');
    await full(6, 'Iron sword no project');
    await db.projectAssets.remove({ projectId: uuid(800), assetId: uuid(6) });
    await full(7, 'Iron sword other type');
    await db.assets.update(uuid(7), { typeId: OTHER_TYPE, updatedAt: TS });
    await full(8, 'Iron sword draft');
    await db.assets.update(uuid(8), { status: 'draft', updatedAt: TS });
    await db.assets.insert(asset(9, 'Iron sword no file tag', { status: 'completed' }));
    await member(9);
    await tagAsset(uuid(9), 'metal');
    await addFile(uuid(9), 'x.png', 'working', 'model');
    await db.assets.insert(asset(10, 'Iron sword reference image', { status: 'completed' }));
    await member(10);
    await tagAsset(uuid(10), 'metal');
    await tagFile(await addFile(uuid(10), 'x.png', 'reference', 'image'), 'rusty');

    const q = {
      projectId: uuid(800),
      typeId: TYPE,
      status: 'completed' as const,
      tagNames: ['metal', 'rusty'],
      fileRole: 'working' as const,
      fileKind: 'model' as const,
    };
    const seen: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await db.assets.list({ ...q, query: 'iron sw', limit: 2, offset });
      expect(page.total).toBe(5);
      seen.push(...page.items.map((a) => a.name));
    }
    expect(seen).toEqual(['Iron sword A', 'Iron sword B', 'Iron sword C', 'Iron sword D', 'Iron sword E']);

    const [first] = (await db.assets.list({ ...q, query: 'iron', limit: 1, offset: 0 })).items;
    expect(first).toMatchObject({ id: uuid(1), projectCount: 1, fileCount: 1, workflowProgress: null });
    await expect(db.assets.list({ ...q, tagNames: ['metal', 'nope'], query: 'iron', limit: 2, offset: 0 })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });
});

describe('list item tags', () => {
  const tagAs = (assetId: string, name: string, displayName: string) =>
    db.tags.addToAsset({ assetId, name, displayName, origin: 'manual', newId: newId(), now: TS });
  const tagFileAs = (fileId: string, name: string, displayName: string) =>
    db.tags.addToFile({ fileId, name, displayName, origin: 'manual', newId: newId(), now: TS });
  const list = async (q: Partial<Parameters<WorkspaceDatabase['assets']['list']>[0]> = {}) =>
    (await db.assets.list({ limit: 60, offset: 0, ...q })).items;
  const byName = (items: AssetSummary[], name: string) => items.find((a) => a.name === name)!;

  /** A complete PNG on the asset, so it can be the automatic cover. */
  const addImage = async (assetId: string, originalName: string) => {
    const id = newId();
    await db.files.insertPending({
      id,
      storageId: STORAGE,
      originalName,
      relativePath: `inbox/${id}.bin`,
      mimeType: 'image/png',
      importedAt: TS,
      kind: 'image',
    });
    await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
    await place(id, assetId);
    return id;
  };

  test('list items carry asset tags and the tags of the effective cover', async () => {
    await db.assets.insert(asset(1, 'A'));
    await tagAs(uuid(1), 'oak', 'Oak');
    await db.tags.addToAsset({ assetId: uuid(1), name: 'fir', displayName: 'Fir', origin: 'ai', newId: newId(), now: TS });
    const chosen = await addFile(uuid(1), 'a.png');
    await tagFile(chosen, 'bark');
    await tagFile(await addFile(uuid(1), 'b.png'), 'moss');
    await db.assets.setCover(uuid(1), chosen, TS);
    await db.assets.insert(asset(2, 'B'));
    await db.assets.insert(asset(3, 'C'));
    await tagFile(await addImage(uuid(3), 'c.png'), 'leaf');

    const items = await list();
    expect(byName(items, 'A').tags).toEqual([
      { name: 'fir', displayName: 'Fir', origin: 'ai' },
      { name: 'oak', displayName: 'Oak', origin: 'manual' },
    ]);
    expect(byName(items, 'A').coverTags.map((t) => t.name)).toEqual(['bark']);
    expect(byName(items, 'B')).toMatchObject({ tags: [], coverTags: [] });
    expect(byName(items, 'C').coverTags.map((t) => t.name)).toEqual(['leaf']);
    expect(byName(items, 'A').matchedTags).toBeUndefined();
    expect(byName(await list({ query: 'a' }), 'A')).toMatchObject({ tags: [{ name: 'fir' }, { name: 'oak' }] });
  });

  test('with tagNames every item reports where each requested tag was found', async () => {
    await db.assets.insert(asset(1, 'A'));
    await tagAs(uuid(1), 'oak', 'Oak');
    await tagFile(await addFile(uuid(1), 'a.png'), 'bark');
    await db.assets.insert(asset(2, 'C'));
    await tagAs(uuid(2), 'oak', 'Oak');
    await tagAsset(uuid(2), 'bark');
    await tagFileAs(await addFile(uuid(2), 'c.png'), 'oak', 'Oak');

    for (const query of [undefined, 'c']) {
      const items = await list({ tagNames: ['oak', 'bark'], ...(query !== undefined && { query }) });
      if (query === undefined) {
        expect(byName(items, 'A').matchedTags).toEqual([
          { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false },
          { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
        ]);
      }
      expect(byName(items, 'C').matchedTags).toEqual([
        { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: true },
        { name: 'bark', displayName: 'bark', onAsset: true, onFiles: false },
      ]);
    }
  });

  test('a tag on a pending file does not count as onFiles', async () => {
    await db.assets.insert(asset(1, 'A'));
    await tagAsset(uuid(1), 'oak');
    const pending = await addInboxFile('a.png', 'pending');
    await place(pending, uuid(1));
    await tagFile(pending, 'oak');
    expect(byName(await list({ tagNames: ['oak'] }), 'A').matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
    ]);
  });
});
