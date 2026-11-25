import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetType, Project } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const typeRows = (base: number): AssetType[] =>
  BUILT_IN_ASSET_TYPES.map((t, i) => ({ id: uuid(base + i), key: t.key, name: t.name, sortOrder: i, builtIn: true }));
const asset = (n: number, name: string, typeId: string, status: Asset['status'] = 'draft'): Asset => ({
  id: uuid(n),
  name,
  typeId,
  description: '',
  status,
  createdAt: TS,
  updatedAt: TS,
});
const project = (n: number, name: string): Project => ({
  id: uuid(n),
  name,
  description: '',
  status: 'active',
  createdAt: TS,
  updatedAt: TS,
});

let dir: string;
let db: WorkspaceDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-lib-'));
  db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('asset type repository', () => {
  test('insertMissing adds only missing keys', async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    await db.assetTypes.insertMissing(typeRows(200));
    const types = await db.assetTypes.list();
    expect(types).toHaveLength(8);
    expect(types.map((t) => t.id)).toEqual(typeRows(100).map((t) => t.id));
    expect(types.map((t) => t.key)).toEqual(BUILT_IN_ASSET_TYPES.map((t) => t.key));
    await expect(db.assetTypes.get(uuid(100))).resolves.toMatchObject({ key: 'character', builtIn: true });
    await expect(db.assetTypes.get(uuid(200))).resolves.toBeNull();
  });
});

describe('project repository', () => {
  test('lists projects by name with their asset count', async () => {
    await db.projects.insert(project(2, 'beta'));
    await db.projects.insert(project(1, 'Alpha'));
    const list = await db.projects.list({ limit: 10, offset: 0 });
    expect(list.items.map((p) => p.name)).toEqual(['Alpha', 'beta']);
    expect(list.items.map((p) => p.assetCount)).toEqual([0, 0]);
    expect(list.total).toBe(2);
  });

  test('pages with a stable total', async () => {
    for (let i = 1; i <= 5; i++) await db.projects.insert(project(i, `P${i}`));
    const page = await db.projects.list({ limit: 2, offset: 2 });
    expect(page.items.map((p) => p.name)).toEqual(['P3', 'P4']);
    expect(page.total).toBe(5);
  });

  test('update returns null for an unknown id and the changed row otherwise', async () => {
    await db.projects.insert(project(1, 'Alpha'));
    await expect(db.projects.update(uuid(9), { name: 'x', updatedAt: TS })).resolves.toBeNull();
    const updated = await db.projects.update(uuid(1), { status: 'archived', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(updated).toEqual({ ...project(1, 'Alpha'), status: 'archived', updatedAt: '2026-02-01T00:00:00.000Z' });
    await expect(db.projects.get(uuid(1))).resolves.toEqual(updated);
  });
});

describe('asset repository', () => {
  const seed = async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    const [prop, building] = [uuid(105), uuid(103)];
    await db.assets.insert(asset(1, 'Gas station', building));
    await db.assets.insert(asset(2, 'gas_pump', prop, 'completed'));
    await db.assets.insert(asset(3, '100% wool', prop));
    await db.assets.insert(asset(4, 'Motel', building, 'completed'));
    return { prop, building };
  };
  const names = async (q: Parameters<WorkspaceDatabase['assets']['list']>[0]) =>
    (await db.assets.list(q)).items.map((a) => a.name);

  test('filters assets by type, status and name', async () => {
    const { prop, building } = await seed();
    const page = { limit: 10, offset: 0 };
    await expect(names({ ...page, nameContains: 'GAS' })).resolves.toEqual(['Gas station', 'gas_pump']);
    await expect(names({ ...page, nameContains: '_' })).resolves.toEqual(['gas_pump']);
    await expect(names({ ...page, nameContains: '%' })).resolves.toEqual(['100% wool']);
    await expect(names({ ...page, typeId: building })).resolves.toEqual(['Gas station', 'Motel']);
    await expect(names({ ...page, typeId: building, status: 'completed' })).resolves.toEqual(['Motel']);
    await expect(names({ ...page, typeId: prop, nameContains: 'gas' })).resolves.toEqual(['gas_pump']);

    const filtered = await db.assets.list({ limit: 1, offset: 0, typeId: building });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.total).toBe(2);
    expect(filtered.items[0]).toMatchObject({ projectCount: 0, fileCount: 0 });
    expect((await db.assets.list(page)).total).toBe(4);
  });

  test('update returns null for an unknown id and the changed row otherwise', async () => {
    const { prop } = await seed();
    await expect(db.assets.update(uuid(9), { name: 'x', updatedAt: TS })).resolves.toBeNull();
    const updated = await db.assets.update(uuid(1), { typeId: prop, status: 'in_review', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(updated).toEqual({
      ...asset(1, 'Gas station', prop, 'in_review'),
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    await expect(db.assets.get(uuid(1))).resolves.toEqual(updated);
  });

  test('rejects an asset with an unknown type', async () => {
    await expect(db.assets.insert(asset(1, 'Orphan', uuid(999)))).rejects.toThrow(/FOREIGN KEY/i);
  });
});
