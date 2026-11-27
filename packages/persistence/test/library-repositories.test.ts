import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetType, FileKind, FileRole, FileScope, Project, ProjectAssignment } from '@assetforge/contracts';
import {
  BUILT_IN_ASSET_TYPES,
  InvalidOperationError,
  NotFoundError,
  type FileMove,
  type FileQuery,
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
    const all = ['100% wool', 'Gas station', 'gas_pump', 'Motel'];
    await expect(names({ ...page, query: 'GAS' })).resolves.toEqual(['Gas station', 'gas_pump']);
    await expect(names({ ...page, query: 'pum' })).resolves.toEqual(['gas_pump']);
    await expect(names({ ...page, query: 'tel' })).resolves.toEqual([]);
    await expect(names({ ...page, query: '_' })).resolves.toEqual(all);
    await expect(names({ ...page, query: '%' })).resolves.toEqual(all);
    await expect(names({ ...page, typeId: building })).resolves.toEqual(['Gas station', 'Motel']);
    await expect(names({ ...page, typeId: building, status: 'completed' })).resolves.toEqual(['Motel']);
    await expect(names({ ...page, typeId: prop, query: 'gas' })).resolves.toEqual(['gas_pump']);

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
      kind: 'image',
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

describe('file dimensions', () => {
  let dir: string;
  let db: WorkspaceDatabase;
  const STORAGE = uuid(900);
  const fileId = (n: number) => uuid(700 + n);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'af-dims-'));
    db = await openWorkspaceDatabase(join(dir, 'assetforge.sqlite'), MIGRATIONS_FOLDER);
    await db.storages.ensurePrimary({ id: STORAGE, createdAt: TS });
  });
  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pending = (n: number) =>
    db.files.insertPending({
      id: fileId(n),
      storageId: STORAGE,
      originalName: `d${n}.png`,
      relativePath: `inbox/d${n}.png`,
      mimeType: 'image/png',
      importedAt: TS,
      kind: 'image',
    });

  test('markComplete stores the size and get returns it', async () => {
    await pending(1);
    await db.files.markComplete(fileId(1), { sizeBytes: 5, sha256: 'a'.repeat(64), width: 1600, height: 2000 });
    const record = await db.files.get(fileId(1));
    expect([record?.width, record?.height]).toEqual([1600, 2000]);
  });

  test('markComplete with nulls stores nulls', async () => {
    await pending(1);
    await db.files.markComplete(fileId(1), { sizeBytes: 5, sha256: 'a'.repeat(64), width: null, height: null });
    const record = await db.files.get(fileId(1));
    expect([record?.width, record?.height]).toEqual([null, null]);
  });

  test('setDimensions stores the size and returns the record with its tags', async () => {
    await pending(1);
    await db.files.markComplete(fileId(1), { sizeBytes: 5, sha256: 'a'.repeat(64), width: null, height: null });
    await db.tags.addToFile({ fileId: fileId(1), name: 'rust', displayName: 'Rust', origin: 'manual', newId: uuid(950), now: TS });
    const record = await db.files.setDimensions(fileId(1), { width: 640, height: 480 });
    expect([record.width, record.height]).toEqual([640, 480]);
    expect(record.tags.map((t) => t.name)).toEqual(['rust']);
    expect((await db.files.get(fileId(1)))?.width).toBe(640);
  });

  test('setDimensions stores the duration when given and keeps it otherwise', async () => {
    await pending(1);
    await db.files.markComplete(fileId(1), { sizeBytes: 5, sha256: 'a'.repeat(64), width: null, height: null });
    expect(await db.files.get(fileId(1))).toMatchObject({ durationMs: null });
    const record = await db.files.setDimensions(fileId(1), { width: 1920, height: 1080, durationMs: 4500 });
    expect(record).toMatchObject({ width: 1920, height: 1080, durationMs: 4500 });
    await db.files.setDimensions(fileId(1), { width: 1280, height: 720 });
    expect(await db.files.get(fileId(1))).toMatchObject({ width: 1280, height: 720, durationMs: 4500 });
    await db.files.setDimensions(fileId(1), { width: 1280, height: 720, durationMs: null });
    expect(await db.files.get(fileId(1))).toMatchObject({ durationMs: null });
  });

  test('setDimensions rejects for an unknown id', async () => {
    await expect(db.files.setDimensions(uuid(999), { width: 1, height: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  test('list and findCompleteBySha256 return the dimensions', async () => {
    await pending(1);
    await db.files.markComplete(fileId(1), { sizeBytes: 5, sha256: 'b'.repeat(64), width: 30, height: 40 });
    const listed = await db.files.list({ scope: { kind: 'all' }, limit: 10, offset: 0 });
    expect(listed.items.map((f) => [f.width, f.height])).toEqual([[30, 40]]);
    const found = await db.files.findCompleteBySha256('b'.repeat(64));
    expect(found.map((f) => [f.width, f.height])).toEqual([[30, 40]]);
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
        kind: 'image',
      });
      await db.files.markComplete(fileId(n), { sizeBytes: n, sha256: String(n).repeat(64), width: null, height: null });
    }
  };
  const move = (n: number, patch: Partial<FileMove> = {}): FileMove => ({
    fileId: fileId(n),
    kind: 'relocate',
    targetRelativePath: `assets/${uuid(1)}/references/f${n}.png`,
    targetAssetId: uuid(1),
    targetRole: 'reference',
    createdAt: TS,
    ...patch,
  });

  test('records carry previewable and openable flags', async () => {
    await seed();
    await db.files.insertPending({
      id: fileId(4),
      storageId: STORAGE,
      originalName: 'setup.exe',
      relativePath: 'inbox/f4_setup.exe',
      mimeType: 'application/octet-stream',
      importedAt: '2026-01-04T00:00:00.000Z',
      kind: 'image',
    });
    await db.files.insertPending({
      id: fileId(5),
      storageId: STORAGE,
      originalName: 'clip.webm',
      relativePath: 'inbox/f5_clip.webm',
      mimeType: 'video/webm',
      importedAt: '2026-01-05T00:00:00.000Z',
      kind: 'video',
    });
    await expect(db.files.get(fileId(1))).resolves.toMatchObject({ previewable: true, thumbnail: true, openable: true });
    await expect(db.files.get(fileId(4))).resolves.toMatchObject({ previewable: false, thumbnail: false, openable: false });
    await expect(db.files.get(fileId(5))).resolves.toMatchObject({
      previewable: false,
      thumbnail: true,
      openable: true,
      kind: 'video',
      durationMs: null,
    });
    const listed = await db.files.list({ limit: 10, offset: 0, scope: { kind: 'inbox' } });
    expect(listed.items.find((f) => f.id === fileId(4))?.openable).toBe(false);
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

describe('asset repository filters', () => {
  let nextId = 2000;
  const newId = () => uuid(nextId++);

  const setup = async () => {
    await db.storages.ensurePrimary({ id: uuid(900), createdAt: TS });
    await db.assetTypes.insertMissing(typeRows(100));
    const typeId = uuid(100);
    const names = async (q: Partial<Parameters<WorkspaceDatabase['assets']['list']>[0]>) =>
      (await db.assets.list({ limit: 50, offset: 0, ...q })).items.map((a) => a.name);
    const addFile = async (
      assetId: string,
      role: FileRole,
      kind: FileKind,
      status: 'complete' | 'pending' | 'failed' = 'complete',
    ) => {
      const id = newId();
      const relativePath = `assets/${assetId}/${id}.bin`;
      await db.files.insertPending({
        id,
        storageId: uuid(900),
        originalName: `${id}.bin`,
        relativePath,
        mimeType: 'application/octet-stream',
        importedAt: TS,
        kind,
      });
      if (status === 'complete') await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      if (status === 'failed') await db.files.markFailed(id, 'x');
      await db.files.setPlacement(id, { relativePath, assetId, role });
      return id;
    };
    const tagAsset = (assetId: string, name: string) =>
      db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    const tagFile = (fileId: string, name: string) =>
      db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    return { typeId, names, addFile, tagAsset, tagFile };
  };

  test('tag filter matches tags on the asset or on its complete files, from different owners', async () => {
    const { typeId, names, addFile, tagAsset, tagFile } = await setup();
    await db.assets.insert(asset(1, 'A', typeId));
    await db.assets.insert(asset(2, 'B', typeId));
    await db.assets.insert(asset(3, 'C', typeId));
    await tagAsset(uuid(1), 'metal');
    await tagFile(await addFile(uuid(1), 'reference', 'image'), 'rusty');
    await tagAsset(uuid(2), 'metal');
    await tagFile(await addFile(uuid(2), 'reference', 'image', 'failed'), 'rusty');
    await tagFile(await addFile(uuid(3), 'reference', 'image'), 'metal');

    await expect(names({ tagNames: ['metal', 'rusty'] })).resolves.toEqual(['A']);
    await expect(names({ tagNames: ['metal'] })).resolves.toEqual(['A', 'B', 'C']);
    await expect(names({ tagNames: ['rusty'] })).resolves.toEqual(['A']);
    const page = await db.assets.list({ limit: 1, offset: 0, tagNames: ['metal'] });
    expect(page.total).toBe(3);
  });

  test('a repeated tag name behaves like the name once', async () => {
    const { typeId, names, tagAsset } = await setup();
    await db.assets.insert(asset(1, 'A', typeId));
    await db.assets.insert(asset(2, 'B', typeId));
    await tagAsset(uuid(1), 'metal');
    await expect(names({ tagNames: ['metal'] })).resolves.toEqual(['A']);
    await expect(names({ tagNames: ['metal', 'metal'] })).resolves.toEqual(['A']);
  });

  test('an unknown tag yields an empty page', async () => {
    const { typeId, tagAsset } = await setup();
    await db.assets.insert(asset(1, 'A', typeId));
    await tagAsset(uuid(1), 'metal');
    await expect(db.assets.list({ limit: 10, offset: 0, tagNames: ['metal', 'nope'] })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  test('fileRole and fileKind each need one complete file and are independent', async () => {
    const { typeId, names, addFile } = await setup();
    await db.assets.insert(asset(1, 'A', typeId));
    await db.assets.insert(asset(2, 'B', typeId));
    await addFile(uuid(1), 'reference', 'image');
    await addFile(uuid(1), 'working', 'model');
    await addFile(uuid(2), 'reference', 'image', 'pending');
    await addFile(uuid(2), 'working', 'model');

    await expect(names({ fileRole: 'working', fileKind: 'image' })).resolves.toEqual(['A']);
    await expect(names({ fileKind: 'image' })).resolves.toEqual(['A']);
    await expect(names({ fileRole: 'working' })).resolves.toEqual(['A', 'B']);
    await expect(names({ fileRole: 'final' })).resolves.toEqual([]);
  });

  test('filters combine with the query and the type', async () => {
    const { typeId, names, addFile, tagAsset } = await setup();
    await db.assets.insert(asset(1, 'Iron sword', typeId));
    await db.assets.insert(asset(2, 'Iron shield', typeId));
    await tagAsset(uuid(1), 'metal');
    await tagAsset(uuid(2), 'metal');
    await addFile(uuid(1), 'reference', 'image');
    await expect(names({ query: 'iron', tagNames: ['metal'], fileKind: 'image', typeId })).resolves.toEqual([
      'Iron sword',
    ]);
  });
});

describe('file repository filters', () => {
  let nextId = 3000;
  const newId = () => uuid(nextId++);

  const setup = async () => {
    await db.storages.ensurePrimary({ id: uuid(900), createdAt: TS });
    await db.assetTypes.insertMissing(typeRows(100));
    await db.assets.insert(asset(1, 'Tree', uuid(100)));
    let minute = 0;
    const addFile = async (originalName: string, kind: FileKind, placement?: { assetId: string; role: FileRole }) => {
      const id = newId();
      const relativePath = `inbox/${id}/${originalName}`;
      // Later files are newer, so the newest-first order is the reverse of insertion.
      const importedAt = new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString();
      await db.files.insertPending({ id, storageId: uuid(900), originalName, relativePath, mimeType: 'image/png', importedAt, kind });
      await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      if (placement) await db.files.setPlacement(id, { relativePath: `assets/${id}`, ...placement });
      return id;
    };
    const tagFile = (fileId: string, name: string) =>
      db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    const tagAsset = (assetId: string, name: string) =>
      db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    const names = async (q: Partial<FileQuery> & Pick<FileQuery, 'scope'>) =>
      (await db.files.list({ limit: 60, offset: 0, ...q })).items.map((f) => f.originalName);
    return { addFile, tagFile, tagAsset, names };
  };
  const inbox: FileScope = { kind: 'inbox' };
  const all: FileScope = { kind: 'all' };
  const tree: FileScope = { kind: 'asset', assetId: uuid(1) };

  test('query folds case and diacritics and matches tag word prefixes', async () => {
    const { addFile, tagFile, names } = await setup();
    await addFile('Säule-01.png', 'image');
    await tagFile(await addFile('wall.png', 'image'), 'sci-fi');
    await addFile('other.png', 'image');

    await expect(names({ scope: inbox, query: 'saule' })).resolves.toEqual(['Säule-01.png']);
    await expect(names({ scope: inbox, query: 'SÄU' })).resolves.toEqual(['Säule-01.png']);
    await expect(names({ scope: inbox, query: 'sci-fi' })).resolves.toEqual(['wall.png']);
    await expect(names({ scope: inbox, query: 'fi' })).resolves.toEqual(['wall.png']);
    await expect(names({ scope: inbox, query: 'all sci' })).resolves.toEqual(['wall.png']); // every word
    await expect(names({ scope: inbox, query: 'ci' })).resolves.toEqual([]); // tags match word prefixes only
    await expect(names({ scope: inbox, query: 'png' })).resolves.toEqual(['other.png', 'wall.png', 'Säule-01.png']);
    await expect(db.files.list({ limit: 1, offset: 1, scope: inbox, query: 'png' })).resolves.toMatchObject({
      items: [{ originalName: 'wall.png' }],
      total: 3,
    });
  });

  test('tagNames require every tag on the file itself', async () => {
    const { addFile, tagFile, tagAsset, names } = await setup();
    await tagAsset(uuid(1), 'oak');
    const f = await addFile('f.png', 'image', { assetId: uuid(1), role: 'texture' });
    await tagFile(f, 'bark');
    await tagFile(f, 'rough');
    await tagFile(await addFile('g.png', 'image', { assetId: uuid(1), role: 'texture' }), 'rough');

    await expect(names({ scope: tree, tagNames: ['bark'] })).resolves.toEqual(['f.png']);
    await expect(names({ scope: tree, tagNames: ['rough'] })).resolves.toEqual(['g.png', 'f.png']);
    await expect(names({ scope: tree, tagNames: ['bark', 'rough'] })).resolves.toEqual(['f.png']);
    await expect(db.files.list({ limit: 60, offset: 0, scope: tree, tagNames: ['bark', 'oak'] })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  test('an unknown tag gives an empty page', async () => {
    const { addFile, tagFile } = await setup();
    await tagFile(await addFile('a.png', 'image'), 'known');
    await expect(db.files.list({ limit: 60, offset: 0, scope: all, tagNames: ['known', 'nope'] })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  test('role and kind filter within the scope', async () => {
    const { addFile, names } = await setup();
    await addFile('tex.png', 'image', { assetId: uuid(1), role: 'texture' });
    await addFile('ref.png', 'image', { assetId: uuid(1), role: 'reference' });
    await addFile('mesh.glb', 'model', { assetId: uuid(1), role: 'texture' });
    await addFile('inbox.glb', 'model');
    await addFile('inbox.png', 'image');

    await expect(names({ scope: tree, role: 'texture' })).resolves.toEqual(['mesh.glb', 'tex.png']);
    await expect(names({ scope: tree, role: 'texture', kind: 'image' })).resolves.toEqual(['tex.png']);
    await expect(names({ scope: inbox, kind: 'model' })).resolves.toEqual(['inbox.glb']);
    await expect(names({ scope: all, kind: 'model' })).resolves.toEqual(['inbox.glb', 'mesh.glb']);
  });
});

describe('project repository filters', () => {
  let nextId = 4000;
  const newId = () => uuid(nextId++);

  const setup = async () => {
    await db.storages.ensurePrimary({ id: uuid(900), createdAt: TS });
    await db.assetTypes.insertMissing(typeRows(100));
    const typeId = uuid(100);
    const addProject = async (name: string, description = '', status: Project['status'] = 'active') => {
      const p = { ...project(0, name), id: newId(), description, status };
      await db.projects.insert(p);
      return p.id;
    };
    const member = async (projectId: string, name: string) => {
      const id = newId();
      await db.assets.insert({ ...asset(0, name, typeId), id });
      await db.projectAssets.insert({
        projectId,
        assetId: id,
        priority: 'normal',
        intendedUse: '',
        approvalStatus: 'pending',
        notes: '',
        assignedAt: TS,
        updatedAt: TS,
      });
      return id;
    };
    const addFile = async (assetId: string, kind: FileKind, status: 'complete' | 'failed' = 'complete') => {
      const id = newId();
      const relativePath = `assets/${assetId}/${id}.bin`;
      await db.files.insertPending({
        id,
        storageId: uuid(900),
        originalName: `${id}.bin`,
        relativePath,
        mimeType: 'application/octet-stream',
        importedAt: TS,
        kind,
      });
      if (status === 'complete') await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      else await db.files.markFailed(id, 'x');
      await db.files.setPlacement(id, { relativePath, assetId, role: 'reference' });
      return id;
    };
    const tagAsset = (assetId: string, name: string) =>
      db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    const tagFile = (fileId: string, name: string) =>
      db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
    type Q = Partial<Parameters<WorkspaceDatabase['projects']['list']>[0]>;
    const list = async (q: Q) => (await db.projects.list({ limit: 60, offset: 0, ...q })).items;
    const names = async (q: Q) => (await list(q)).map((p) => p.name);
    return { addProject, member, addFile, tagAsset, tagFile, list, names };
  };

  test('query matches a folded substring of name or description', async () => {
    const { addProject, names } = await setup();
    await addProject('Forest', 'Älter Wald');
    await addProject('Desert', 'sand');
    await addProject('Kältere Stadt');
    await expect(names({ query: 'alter' })).resolves.toEqual(['Forest', 'Kältere Stadt']);
    await expect(names({ query: 'WALD' })).resolves.toEqual(['Forest']);
    await expect(names({ query: 'ter wa' })).resolves.toEqual(['Forest']);
    await expect(names({ query: 'ocean' })).resolves.toEqual([]);
    await expect(db.projects.list({ limit: 1, offset: 1, query: 'alter' })).resolves.toMatchObject({
      items: [{ name: 'Kältere Stadt' }],
      total: 2,
    });
  });

  test('status filters', async () => {
    const { addProject, names } = await setup();
    await addProject('A');
    await addProject('B', '', 'on_hold');
    await expect(names({ status: 'on_hold' })).resolves.toEqual(['B']);
    await expect(names({ status: 'active' })).resolves.toEqual(['A']);
    await expect(names({ status: 'archived' })).resolves.toEqual([]);
  });

  test('a project matches only when one member asset carries all tags', async () => {
    const { addProject, member, addFile, tagAsset, tagFile, names } = await setup();
    const p1 = await addProject('P1');
    const x = await member(p1, 'X');
    await tagAsset(x, 'oak');
    await tagFile(await addFile(x, 'image'), 'bark');
    await tagAsset(await member(p1, 'W'), 'moss');
    const p2 = await addProject('P2');
    await tagAsset(await member(p2, 'Y'), 'oak');
    await tagAsset(await member(p2, 'Z'), 'bark');
    const p3 = await addProject('P3');
    const v = await member(p3, 'V');
    await tagAsset(v, 'oak');
    await tagFile(await addFile(v, 'image', 'failed'), 'bark');

    const page = await db.projects.list({ limit: 60, offset: 0, tagNames: ['oak', 'bark'] });
    expect(page.items.map((p) => p.name)).toEqual(['P1']);
    expect(page.total).toBe(1);
    expect(page.items[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
    await expect(names({ tagNames: ['oak'] })).resolves.toEqual(['P1', 'P2', 'P3']);
  });

  test('matchedTags aggregate only over the member assets that carry all tags', async () => {
    const { addProject, member, addFile, tagAsset, tagFile, list } = await setup();
    const p = await addProject('P');
    await tagAsset(await member(p, 'A'), 'oak');
    const b = await member(p, 'B');
    await tagFile(await addFile(b, 'image'), 'oak');
    await tagFile(await addFile(b, 'image'), 'bark');
    expect((await list({ tagNames: ['oak'] }))[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: true },
    ]);
    // Only B carries both tags; A's asset tag does not count.
    expect((await list({ tagNames: ['oak', 'bark'] }))[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: false, onFiles: true },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
  });

  test('an unknown tag yields an empty page', async () => {
    const { addProject, member, tagAsset } = await setup();
    await tagAsset(await member(await addProject('P'), 'A'), 'oak');
    await expect(db.projects.list({ limit: 10, offset: 0, tagNames: ['oak', 'nope'] })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  test('imageCount counts complete image files over member assets', async () => {
    const { addProject, member, addFile, list } = await setup();
    const p = await addProject('P');
    const a = await member(p, 'A');
    await addFile(a, 'image');
    await addFile(a, 'image', 'failed');
    await addFile(a, 'model');
    await addFile(await member(p, 'B'), 'image');
    await addProject('Empty');
    expect((await list({})).map((x) => [x.name, x.assetCount, x.imageCount])).toEqual([
      ['Empty', 0, 0],
      ['P', 2, 2],
    ]);
  });

  test('without filters matchedTags is absent', async () => {
    const { addProject, member, tagAsset, list } = await setup();
    await tagAsset(await member(await addProject('B'), 'A'), 'oak');
    await addProject('A');
    const items = await list({ limit: 200 });
    expect(items.map((p) => p.name)).toEqual(['A', 'B']);
    expect(items.every((p) => !('matchedTags' in p))).toBe(true);
  });

  test('filters combine', async () => {
    const { addProject, member, tagAsset, names } = await setup();
    await tagAsset(await member(await addProject('Oak forest'), 'A'), 'oak');
    await tagAsset(await member(await addProject('Oak grove', '', 'archived'), 'B'), 'oak');
    await addProject('Oak hill');
    await expect(names({ query: 'oak', status: 'active', tagNames: ['oak'] })).resolves.toEqual(['Oak forest']);
  });
});
