import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetType, Project, ProjectAssignment } from '@assetforge/contracts';
import {
  BUILT_IN_ASSET_TYPES,
  InvalidOperationError,
  NotFoundError,
  type FileMove,
  type WorkspaceDatabase,
} from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const typeRows = (base: number): AssetType[] =>
  BUILT_IN_ASSET_TYPES.map((t, i) => ({
    id: uuid(base + i),
    key: t.key,
    name: t.name,
    sortOrder: i,
    builtIn: true,
    defaultWorkflowTemplateId: null,
  }));
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

describe('project assignments', () => {
  const assignment = (projectN: number, assetN: number, patch: Partial<ProjectAssignment> = {}): ProjectAssignment => ({
    projectId: uuid(projectN),
    assetId: uuid(assetN),
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: '',
    assignedAt: TS,
    updatedAt: TS,
    ...patch,
  });
  const seed = async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    const typeId = uuid(105);
    await db.projects.insert(project(1, 'Zeta'));
    await db.projects.insert(project(2, 'alpha'));
    await db.assets.insert(asset(11, 'Pump', typeId));
    await db.assets.insert(asset(12, 'Motel', typeId));
    await db.assets.insert(asset(13, 'Unassigned', typeId));
  };

  test('an asset can be assigned to several projects', async () => {
    await seed();
    await db.projectAssets.insert(assignment(1, 11, { priority: 'high', notes: 'n' }));
    await db.projectAssets.insert(assignment(2, 11));
    const list = await db.projectAssets.listByAsset(uuid(11));
    expect(list.map((a) => a.project.name)).toEqual(['alpha', 'Zeta']);
    expect(list[1]).toEqual({ ...assignment(1, 11, { priority: 'high', notes: 'n' }), project: project(1, 'Zeta') });
    await expect(db.projectAssets.listByAsset(uuid(13))).resolves.toEqual([]);
  });

  test('the same assignment cannot be inserted twice', async () => {
    await seed();
    await db.projectAssets.insert(assignment(1, 11));
    await expect(db.projectAssets.insert(assignment(1, 11))).rejects.toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  test('get and update change only the given fields and report a missing row', async () => {
    await seed();
    const key = { projectId: uuid(1), assetId: uuid(11) };
    await expect(db.projectAssets.get(key)).resolves.toBeNull();
    await expect(db.projectAssets.update(key, { notes: 'x', updatedAt: TS })).resolves.toBeNull();
    await db.projectAssets.insert(assignment(1, 11));
    const updated = await db.projectAssets.update(key, {
      approvalStatus: 'approved',
      intendedUse: 'hero',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(updated).toEqual(
      assignment(1, 11, { approvalStatus: 'approved', intendedUse: 'hero', updatedAt: '2026-02-01T00:00:00.000Z' }),
    );
    await expect(db.projectAssets.get(key)).resolves.toEqual(updated);
  });

  test('removing an assignment leaves the asset, its file rows and its other assignments', async () => {
    await seed();
    const storage = await db.storages.ensurePrimary({ id: uuid(500), createdAt: TS });
    await db.files.insertPending({
      id: uuid(600),
      storageId: storage.id,
      originalName: 'pump.png',
      relativePath: 'files/pump.png',
      mimeType: 'image/png',
      importedAt: TS,
    });
    await db.projectAssets.insert(assignment(1, 11));
    await db.projectAssets.insert(assignment(2, 11));
    await expect(db.projectAssets.remove({ projectId: uuid(1), assetId: uuid(11) })).resolves.toBe(true);
    await expect(db.projectAssets.remove({ projectId: uuid(1), assetId: uuid(11) })).resolves.toBe(false);
    await expect(db.assets.get(uuid(11))).resolves.not.toBeNull();
    await expect(db.projects.get(uuid(1))).resolves.not.toBeNull();
    await expect(db.files.listByStatus('pending')).resolves.toHaveLength(1);
    expect((await db.projectAssets.listByAsset(uuid(11))).map((a) => a.projectId)).toEqual([uuid(2)]);
  });

  test('listByProject pages members with their asset', async () => {
    await seed();
    await db.projectAssets.insert(assignment(1, 11));
    await db.projectAssets.insert(assignment(1, 12));
    await db.projectAssets.insert(assignment(2, 12));
    const first = await db.projectAssets.listByProject(uuid(1), { limit: 1, offset: 0 });
    expect(first.total).toBe(2);
    expect(first.items).toEqual([{ ...assignment(1, 12), asset: asset(12, 'Motel', uuid(105)) }]);
    const second = await db.projectAssets.listByProject(uuid(1), { limit: 1, offset: 1 });
    expect(second.items.map((m) => m.asset.name)).toEqual(['Pump']);
    await expect(db.projectAssets.listByProject(uuid(9), { limit: 5, offset: 0 })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  test('project and asset lists report assignment counts', async () => {
    await seed();
    await db.projectAssets.insert(assignment(1, 11));
    await db.projectAssets.insert(assignment(1, 12));
    await db.projectAssets.insert(assignment(2, 12));
    const projects = await db.projects.list({ limit: 10, offset: 0 });
    expect(projects.items.map((p) => [p.name, p.assetCount])).toEqual([
      ['alpha', 1],
      ['Zeta', 2],
    ]);
    const all = await db.assets.list({ limit: 10, offset: 0 });
    expect(all.items.map((a) => [a.name, a.projectCount])).toEqual([
      ['Motel', 2],
      ['Pump', 1],
      ['Unassigned', 0],
    ]);
    const inZeta = await db.assets.list({ limit: 10, offset: 0, projectId: uuid(1) });
    expect(inZeta.items.map((a) => a.name)).toEqual(['Motel', 'Pump']);
    expect(inZeta.total).toBe(2);
    const inAlpha = await db.assets.list({ limit: 1, offset: 0, projectId: uuid(2) });
    expect(inAlpha.items.map((a) => a.name)).toEqual(['Motel']);
    expect(inAlpha.total).toBe(1);
    await expect(db.assets.list({ limit: 10, offset: 0, projectId: uuid(9) })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });
});

describe('file placement and moves', () => {
  const STORAGE = uuid(500);
  const fileId = (n: number) => uuid(600 + n);
  const seed = async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    await db.storages.ensurePrimary({ id: STORAGE, createdAt: TS });
    await db.assets.insert(asset(1, 'Pump', uuid(105)));
    await db.assets.insert(asset(2, 'Motel', uuid(105)));
    for (const n of [1, 2, 3]) {
      await db.files.insertPending({
        id: fileId(n),
        storageId: STORAGE,
        originalName: `f${n}.png`,
        relativePath: `inbox/f${n}.png`,
        mimeType: 'image/png',
        importedAt: `2026-01-0${n}T00:00:00.000Z`,
      });
      await db.files.markComplete(fileId(n), { sizeBytes: n, sha256: String(n).repeat(64) });
    }
  };
  const move = (n: number, patch: Partial<FileMove> = {}): FileMove => ({
    fileId: fileId(n),
    targetRelativePath: `assets/${uuid(1)}/references/f${n}.png`,
    targetAssetId: uuid(1),
    targetRole: 'reference',
    createdAt: TS,
    ...patch,
  });

  test('get returns the record or null', async () => {
    await seed();
    await expect(db.files.get(fileId(1))).resolves.toMatchObject({ id: fileId(1), relativePath: 'inbox/f1.png' });
    await expect(db.files.get(uuid(999))).resolves.toBeNull();
  });

  test('commit applies the target and deletes the move row atomically', async () => {
    await seed();
    await db.fileMoves.begin(move(1));
    await expect(db.fileMoves.list()).resolves.toEqual([move(1)]);
    const before = await db.files.get(fileId(1));
    const committed = await db.fileMoves.commit(fileId(1));
    expect(committed).toEqual({
      ...before,
      relativePath: move(1).targetRelativePath,
      assetId: uuid(1),
      role: 'reference',
    });
    await expect(db.files.get(fileId(1))).resolves.toEqual(committed);
    await expect(db.fileMoves.list()).resolves.toEqual([]);

    // A commit whose update fails (the target path belongs to another file) changes nothing.
    await db.fileMoves.begin(move(2, { targetRelativePath: 'inbox/f3.png', targetAssetId: null, targetRole: null }));
    const two = await db.files.get(fileId(2));
    await expect(db.fileMoves.commit(fileId(2))).rejects.toThrow(/UNIQUE/i);
    await expect(db.files.get(fileId(2))).resolves.toEqual(two);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);
  });

  test('commit rejects with not_found when there is no move row', async () => {
    await seed();
    await expect(db.fileMoves.commit(fileId(1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.fileMoves.commit(fileId(1))).rejects.toMatchObject({ code: 'not_found' });
  });

  test('begin rejects a second move for the same file', async () => {
    await seed();
    await db.fileMoves.begin(move(1));
    await expect(db.fileMoves.begin(move(1, { targetRole: 'concept' }))).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(db.fileMoves.list()).resolves.toEqual([move(1)]);
  });

  test('abort removes the move row and is a no-op when missing', async () => {
    await seed();
    await db.fileMoves.begin(move(1));
    await db.fileMoves.abort(fileId(1));
    await expect(db.fileMoves.abort(fileId(1))).resolves.toBeUndefined();
    await expect(db.fileMoves.list()).resolves.toEqual([]);
    await expect(db.files.get(fileId(1))).resolves.toMatchObject({ relativePath: 'inbox/f1.png', assetId: null });
  });

  test('lists move rows by createdAt, then fileId', async () => {
    await seed();
    await db.fileMoves.begin(move(3, { createdAt: '2026-01-02T00:00:00.000Z' }));
    await db.fileMoves.begin(move(2));
    await db.fileMoves.begin(move(1));
    expect((await db.fileMoves.list()).map((m) => m.fileId)).toEqual([fileId(1), fileId(2), fileId(3)]);
  });

  test('lists files by scope', async () => {
    await seed();
    await db.files.setPlacement(fileId(1), { relativePath: 'assets/a/references/f1.png', assetId: uuid(1), role: 'reference' });
    await db.files.setPlacement(fileId(2), { relativePath: 'assets/b/models/f2.png', assetId: uuid(2), role: 'model' });
    const page = { limit: 10, offset: 0 };
    const all = await db.files.list({ ...page, scope: { kind: 'all' } });
    expect(all.items.map((f) => f.id)).toEqual([fileId(3), fileId(2), fileId(1)]);
    expect(all.total).toBe(3);
    const inbox = await db.files.list({ ...page, scope: { kind: 'inbox' } });
    expect(inbox).toMatchObject({ total: 1, items: [{ id: fileId(3), assetId: null, role: null }] });
    const pump = await db.files.list({ limit: 1, offset: 0, scope: { kind: 'asset', assetId: uuid(1) } });
    expect(pump).toMatchObject({ total: 1, items: [{ id: fileId(1), assetId: uuid(1), role: 'reference' }] });
    await expect(db.files.list({ ...page, scope: { kind: 'asset', assetId: uuid(9) } })).resolves.toEqual({
      items: [],
      total: 0,
    });
    const counts = (await db.assets.list(page)).items.map((a) => [a.name, a.fileCount]);
    expect(counts).toEqual([
      ['Motel', 1],
      ['Pump', 1],
    ]);
  });

  test('setPlacement rejects for an unknown id', async () => {
    await seed();
    await expect(
      db.files.setPlacement(uuid(999), { relativePath: 'inbox/x.png', assetId: null, role: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('a file cannot reference an unknown asset', async () => {
    await seed();
    await expect(
      db.files.setPlacement(fileId(1), { relativePath: 'assets/x/references/f1.png', assetId: uuid(9), role: 'reference' }),
    ).rejects.toThrow(/FOREIGN KEY/i);
    await expect(db.fileMoves.begin(move(1, { targetAssetId: uuid(9) }))).rejects.toThrow(/FOREIGN KEY/i);
    await expect(db.files.get(fileId(1))).resolves.toMatchObject({ assetId: null, relativePath: 'inbox/f1.png' });
  });

  test('removing an assignment leaves the files of the asset unchanged', async () => {
    await seed();
    await db.projects.insert(project(1, 'Game'));
    const placed = await db.files.setPlacement(fileId(1), {
      relativePath: `assets/${uuid(1)}/references/f1.png`,
      assetId: uuid(1),
      role: 'reference',
    });
    await db.projectAssets.insert({
      projectId: uuid(1),
      assetId: uuid(1),
      priority: 'normal',
      intendedUse: '',
      approvalStatus: 'pending',
      notes: '',
      assignedAt: TS,
      updatedAt: TS,
    });
    await db.projectAssets.remove({ projectId: uuid(1), assetId: uuid(1) });
    await expect(db.files.get(fileId(1))).resolves.toEqual(placed);
    expect((await db.assets.list({ limit: 10, offset: 0 })).items.find((a) => a.id === uuid(1))?.fileCount).toBe(1);
  });
});

describe('asset relations', () => {
  const seed = async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    const typeId = uuid(105);
    await db.assets.insert(asset(1, 'Pump', typeId));
    await db.assets.insert(asset(2, 'Station', typeId));
    await db.assets.insert(asset(3, 'Alpha', typeId));
  };
  const relation = (from: number, to: number, kind: 'uses' | 'part_of' | 'variant_of' = 'uses') => ({
    fromAssetId: uuid(from),
    toAssetId: uuid(to),
    kind,
    createdAt: TS,
  });

  test('insert returns false for an existing relation', async () => {
    await seed();
    await expect(db.relations.insert(relation(1, 2))).resolves.toBe(true);
    await expect(db.relations.insert({ ...relation(1, 2), createdAt: '2027-01-01T00:00:00.000Z' })).resolves.toBe(false);
    await expect(db.relations.insert(relation(1, 2, 'part_of'))).resolves.toBe(true);
    await expect(db.relations.insert(relation(2, 1))).resolves.toBe(true);
    const outgoing = (await db.relations.listForAsset(uuid(1))).filter((r) => r.direction === 'outgoing');
    expect(outgoing.find((r) => r.kind === 'uses')?.createdAt).toBe(TS);
  });

  test('listForAsset returns outgoing and incoming relations with the other asset', async () => {
    await seed();
    await db.relations.insert(relation(1, 2, 'uses'));
    await db.relations.insert(relation(1, 3, 'uses'));
    await db.relations.insert(relation(1, 2, 'part_of'));
    await db.relations.insert(relation(3, 1, 'variant_of'));
    const list = await db.relations.listForAsset(uuid(1));
    expect(list.map((r) => [r.direction, r.kind, r.other.name])).toEqual([
      ['outgoing', 'part_of', 'Station'],
      ['outgoing', 'uses', 'Alpha'],
      ['outgoing', 'uses', 'Station'],
      ['incoming', 'variant_of', 'Alpha'],
    ]);
    expect(list[1]).toEqual({ ...relation(1, 3), direction: 'outgoing', other: asset(3, 'Alpha', uuid(105)) });
    const incoming = await db.relations.listForAsset(uuid(2));
    expect(incoming.map((r) => [r.direction, r.kind, r.other.name])).toEqual([
      ['incoming', 'part_of', 'Pump'],
      ['incoming', 'uses', 'Pump'],
    ]);
  });

  test('remove reports whether a relation existed', async () => {
    await seed();
    await db.relations.insert(relation(1, 2));
    await expect(db.relations.remove(relation(1, 2, 'part_of'))).resolves.toBe(false);
    await expect(db.relations.remove(relation(1, 2))).resolves.toBe(true);
    await expect(db.relations.listForAsset(uuid(1))).resolves.toEqual([]);
  });

  test('rejects a relation of an asset to itself', async () => {
    await seed();
    await expect(db.relations.insert(relation(1, 1))).rejects.toThrow(/CHECK/i);
  });
});
