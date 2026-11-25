import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ASSET_TYPES,
  NotFoundError,
  WorkspaceManager,
  createAsset,
  createProject,
  getAsset,
  getWorkflow,
  listAssets,
  listAssetTypes,
  updateAsset,
  updateProject,
  type AssetQuery,
  type WorkspaceSession,
} from '../src/index.js';
import type { FileKind, FileRole } from '@assetforge/contracts';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

function setup() {
  const fake = createFakeHost();
  let tick = 0;
  // A fixed clock that advances by one minute per call.
  fake.host.now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++, 0));
  return { ...fake, manager: new WorkspaceManager(fake.host) };
}

async function openSession() {
  const ctx = setup();
  await ctx.manager.create({ name: 'Demo', rootPath: ROOT });
  const session: WorkspaceSession = await ctx.manager.read(async (s) => s);
  return { ...ctx, session };
}

describe('asset types', () => {
  it('opening a workspace seeds the eight built-in asset types once', async () => {
    const { manager, session } = await openSession();
    const first = await listAssetTypes(session);
    expect(first.map((t) => t.key)).toEqual(BUILT_IN_ASSET_TYPES.map((t) => t.key));
    expect(first).toHaveLength(8);
    expect(first.every((t) => t.builtIn)).toBe(true);
    expect(first.map((t) => t.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await manager.open({ rootPath: ROOT });
    const again = await listAssetTypes(await manager.read(async (s) => s));
    expect(again).toEqual(first);
  });
});

describe('projects', () => {
  it('createProject applies defaults', async () => {
    const { session } = await openSession();
    const project = await createProject(session, { name: 'Game' });
    expect(project).toMatchObject({ name: 'Game', description: '', status: 'active' });
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it('updateProject can archive a project', async () => {
    const { session } = await openSession();
    const project = await createProject(session, { name: 'Game' });
    const updated = await updateProject(session, project.id, { status: 'archived' });
    expect(updated.status).toBe('archived');
    expect(updated.name).toBe('Game');
    expect(updated.updatedAt > project.updatedAt).toBe(true);
  });

  it('updateProject rejects an unknown id with not_found', async () => {
    const { session } = await openSession();
    await expect(updateProject(session, UNKNOWN_ID, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('assets', () => {
  it('createAsset rejects an unknown type with not_found', async () => {
    const { session } = await openSession();
    const error = await createAsset(session, { name: 'Hero', typeId: UNKNOWN_ID }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('not_found');
  });

  it('createAsset applies defaults', async () => {
    const { session } = await openSession();
    const [type] = await listAssetTypes(session);
    const asset = await createAsset(session, { name: 'Hero', typeId: type!.id });
    expect(asset).toMatchObject({ name: 'Hero', typeId: type!.id, description: '', status: 'draft' });
    expect(asset.createdAt).toBe(asset.updatedAt);
  });

  it('createAsset starts the default workflow of the type; updateAsset leaves it alone', async () => {
    const { session } = await openSession();
    const types = await listAssetTypes(session);
    const material = types.find((t) => t.key === 'material')!;
    const asset = await createAsset(session, { name: 'Rust', typeId: material.id });
    const workflow = await getWorkflow(session, asset.id);
    expect(workflow).toMatchObject({ assetId: asset.id, templateId: material.defaultWorkflowTemplateId });
    await updateAsset(session, asset.id, { name: 'Old rust', typeId: types[0]!.id, status: 'in_review' });
    expect(await getWorkflow(session, asset.id)).toEqual(workflow);
  });

  it('updateAsset changes only the given fields and bumps updatedAt', async () => {
    const { session } = await openSession();
    const [type, other] = await listAssetTypes(session);
    const asset = await createAsset(session, { name: 'Hero', typeId: type!.id, description: 'Tall' });

    const renamed = await updateAsset(session, asset.id, { name: 'Villain' });
    expect(renamed).toMatchObject({ name: 'Villain', description: 'Tall', typeId: type!.id, status: 'draft' });
    expect(renamed.updatedAt > asset.updatedAt).toBe(true);
    expect(renamed.createdAt).toBe(asset.createdAt);

    const retyped = await updateAsset(session, asset.id, { typeId: other!.id, status: 'in_review' });
    expect(retyped).toMatchObject({ name: 'Villain', typeId: other!.id, status: 'in_review' });
    expect(await getAsset(session, asset.id)).toEqual(retyped);
  });

  it('updateAsset rejects an unknown type and an unknown id with not_found', async () => {
    const { session } = await openSession();
    const [type] = await listAssetTypes(session);
    const asset = await createAsset(session, { name: 'Hero', typeId: type!.id });
    await expect(updateAsset(session, asset.id, { typeId: UNKNOWN_ID })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAsset(session, UNKNOWN_ID, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getAsset rejects an unknown id with not_found', async () => {
    const { session } = await openSession();
    await expect(getAsset(session, UNKNOWN_ID)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('asset list filters', () => {
  async function seed() {
    const ctx = await openSession();
    const { session } = ctx;
    const [type] = await listAssetTypes(session);
    const db = session.database;
    const make = (name: string, description = '') => createAsset(session, { name, typeId: type!.id, description });
    let n = 0;
    const addFile = async (
      assetId: string,
      role: FileRole,
      kind: FileKind,
      originalName: string,
      status: 'complete' | 'pending' | 'failed' = 'complete',
    ) => {
      const id = `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      await db.files.insertPending({
        id,
        storageId: 's',
        originalName,
        relativePath: `assets/${assetId}/${originalName}`,
        mimeType: 'application/octet-stream',
        importedAt: '2026-01-01T00:00:00.000Z',
        kind,
      });
      if (status === 'complete') await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64) });
      if (status === 'failed') await db.files.markFailed(id, 'x');
      await db.files.setPlacement(id, { relativePath: `assets/${assetId}/${originalName}`, assetId, role });
      return id;
    };
    const tagAsset = (assetId: string, name: string) =>
      db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const tagFile = (fileId: string, name: string) =>
      db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const names = async (q: Partial<AssetQuery>) =>
      (await listAssets(session, { limit: 50, offset: 0, ...q })).items.map((a) => a.name);
    return { session, make, addFile, tagAsset, tagFile, names };
  }

  it('query matches word prefixes in name, description, tags and complete file names', async () => {
    const { make, addFile, tagAsset, tagFile, names } = await seed();
    await make('Sword');
    await make('A', 'a shiny blade');
    const byTag = await make('B');
    await tagAsset(byTag.id, 'weapon');
    const byFileTag = await make('C');
    await tagFile(await addFile(byFileTag.id, 'reference', 'image', 'c.png'), 'ornate');
    const byFileName = await make('D');
    await addFile(byFileName.id, 'reference', 'image', 'katana.png');
    const failed = await make('E');
    await addFile(failed.id, 'reference', 'image', 'halberd.png', 'failed');

    expect(await names({ query: 'swo' })).toEqual(['Sword']);
    expect(await names({ query: 'ord' })).toEqual([]);
    expect(await names({ query: 'blad' })).toEqual(['A']);
    expect(await names({ query: 'weap' })).toEqual(['B']);
    expect(await names({ query: 'ornat' })).toEqual(['C']);
    expect(await names({ query: 'kata' })).toEqual(['D']);
    expect(await names({ query: 'halb' })).toEqual([]);
  });

  it('all words must match', async () => {
    const { make, names } = await seed();
    await make('Iron sword', 'rusty');
    await make('Iron shield');
    expect(await names({ query: 'iron rus' })).toEqual(['Iron sword']);
    expect(await names({ query: 'iron gold' })).toEqual([]);
  });

  it('diacritics and case are folded', async () => {
    const { make, names } = await seed();
    await make('Café');
    expect(await names({ query: 'cafe' })).toEqual(['Café']);
    expect(await names({ query: 'CAFÉ' })).toEqual(['Café']);
  });

  it('a name match ranks before a description match', async () => {
    const { make, names } = await seed();
    await make('Alpha', 'a rusty thing');
    await make('Rusty gate');
    expect(await names({ query: 'rusty' })).toEqual(['Rusty gate', 'Alpha']);
  });

  it('tag filter matches tags on the asset or on its complete files', async () => {
    const { make, addFile, tagAsset, tagFile, names } = await seed();
    const a = await make('A');
    await tagAsset(a.id, 'metal');
    await tagFile(await addFile(a.id, 'reference', 'image', 'a.png'), 'rusty');
    const b = await make('B');
    await tagFile(await addFile(b.id, 'reference', 'image', 'b.png', 'failed'), 'rusty');
    await tagAsset(b.id, 'metal');

    expect(await names({ tagNames: ['metal', 'rusty'] })).toEqual(['A']);
    expect(await names({ tagNames: ['metal'] })).toEqual(['A', 'B']);
    expect(await names({ tagNames: ['  METAL '] })).toEqual(['A', 'B']);
  });

  it('an unknown tag yields no results', async () => {
    const { make, tagAsset, names } = await seed();
    await tagAsset((await make('A')).id, 'metal');
    expect(await names({ tagNames: ['metal', 'nope'] })).toEqual([]);
  });

  it('fileRole and fileKind each need one complete file and are independent', async () => {
    const { make, addFile, names } = await seed();
    const a = await make('A');
    await addFile(a.id, 'reference', 'image', 'a.png');
    await addFile(a.id, 'working', 'model', 'a.glb');
    const b = await make('B');
    await addFile(b.id, 'reference', 'image', 'b.png', 'pending');
    await addFile(b.id, 'working', 'model', 'b.glb');

    expect(await names({ fileRole: 'working', fileKind: 'image' })).toEqual(['A']);
    expect(await names({ fileKind: 'image' })).toEqual(['A']);
    expect(await names({ fileRole: 'working' })).toEqual(['A', 'B']);
  });

  it('filters combine with the query', async () => {
    const { make, addFile, tagAsset, names } = await seed();
    const a = await make('Iron sword');
    await tagAsset(a.id, 'metal');
    await addFile(a.id, 'reference', 'image', 'a.png');
    const b = await make('Iron shield');
    await tagAsset(b.id, 'metal');
    expect(await names({ query: 'iron', tagNames: ['metal'], fileKind: 'image' })).toEqual(['Iron sword']);
  });

  it('listAssets rejects an invalid tag name and drops a query without words', async () => {
    const { session, make } = await seed();
    await make('A');
    await expect(listAssets(session, { limit: 5, offset: 0, tagNames: ['  '] })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await listAssets(session, { limit: 5, offset: 0, query: '"*-' })).total).toBe(1);
  });
});
