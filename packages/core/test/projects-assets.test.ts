import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ASSET_TYPES,
  NotFoundError,
  WorkspaceManager,
  assignAsset,
  createAsset,
  createProject,
  ensureBuiltInAssetTypes,
  getAsset,
  getWorkflow,
  listAssets,
  listAssetTypes,
  listProjects,
  updateAsset,
  updateProject,
  type AssetQuery,
  type ProjectQuery,
  type WorkspaceSession,
} from '../src/index.js';
import type { AssetSummary, FileKind, FileRole } from '@assetforge/contracts';
import { createFakeHost, InMemoryDatabase } from './fakes.js';

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

  it('draws an id only for a built-in type that is missing', async () => {
    const database = new InMemoryDatabase();
    let drawn = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++drawn).padStart(12, '0')}`;
    await ensureBuiltInAssetTypes({ database, newId });
    expect(drawn).toBe(BUILT_IN_ASSET_TYPES.length);

    await ensureBuiltInAssetTypes({ database, newId });
    expect(drawn).toBe(BUILT_IN_ASSET_TYPES.length);
    await expect(database.assetTypes.list()).resolves.toHaveLength(BUILT_IN_ASSET_TYPES.length);
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

  it('the list sorts like lower(name) in SQLite: only A to Z are folded, then code point order', async () => {
    const { session } = await openSession();
    const [type] = await listAssetTypes(session);
    for (const name of ['Zebra', 'Ärger', 'apple', 'ärmel']) await createAsset(session, { name, typeId: type!.id });
    const names = (await listAssets(session, { limit: 10, offset: 0 })).items.map((a) => a.name);
    expect(names).toEqual(['apple', 'Zebra', 'Ärger', 'ärmel']);
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
      mimeType = 'application/octet-stream',
    ) => {
      const id = `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      await db.files.insertPending({
        id,
        storageId: 's',
        originalName,
        relativePath: `assets/${assetId}/${originalName}`,
        mimeType,
        importedAt: '2026-01-01T00:00:00.000Z',
        kind,
      });
      if (status === 'complete')
        await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      if (status === 'failed') await db.files.markFailed(id, 'x');
      await db.files.setPlacement(id, { relativePath: `assets/${assetId}/${originalName}`, assetId, role });
      return id;
    };
    const tagAsset = (assetId: string, name: string, displayName = name) =>
      db.tags.addToAsset({ assetId, name, displayName, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const tagFile = (fileId: string, name: string, displayName = name) =>
      db.tags.addToFile({ fileId, name, displayName, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const list = async (q: Partial<AssetQuery>) => (await listAssets(session, { limit: 60, offset: 0, ...q })).items;
    const names = async (q: Partial<AssetQuery>) => (await list({ limit: 50, ...q })).map((a) => a.name);
    return { session, make, addFile, tagAsset, tagFile, list, names };
  }

  const byName = (items: AssetSummary[], name: string): AssetSummary => items.find((a) => a.name === name)!;

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

  it('a word of marks alone is ignored', async () => {
    const { make, names } = await seed();
    await make('Sword');
    await make('Shield');
    expect(await names({ query: 'sword ⚔️' })).toEqual(['Sword']);
    expect(await names({ query: '⚔️' })).toEqual(['Shield', 'Sword']);
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

  it('list items carry asset tags and the tags of the effective cover', async () => {
    const { session, make, addFile, tagAsset, tagFile, list } = await seed();
    const a = await make('A');
    await tagAsset(a.id, 'oak', 'Oak');
    const cover = await addFile(a.id, 'reference', 'image', 'a.png', 'complete', 'image/png');
    await tagFile(cover, 'bark');
    await tagFile(await addFile(a.id, 'reference', 'image', 'b.png'), 'moss');
    await session.database.assets.setCover(a.id, cover, 'now');
    await make('B');

    const items = await list({});
    expect(byName(items, 'A').tags.map((t) => t.name)).toEqual(['oak']);
    expect(byName(items, 'A').coverTags.map((t) => t.name)).toEqual(['bark']);
    expect(byName(items, 'B')).toMatchObject({ tags: [], coverTags: [] });
    expect(byName(items, 'A').matchedTags).toBeUndefined();
  });

  it('with tagNames every item reports where each requested tag was found', async () => {
    const { make, addFile, tagAsset, tagFile, list } = await seed();
    const a = await make('A');
    await tagAsset(a.id, 'oak', 'Oak');
    await tagFile(await addFile(a.id, 'reference', 'image', 'a.png'), 'bark');
    const c = await make('C');
    await tagAsset(c.id, 'oak', 'Oak');
    await tagAsset(c.id, 'bark');
    await tagFile(await addFile(c.id, 'reference', 'image', 'c.png'), 'oak', 'Oak');

    const items = await list({ tagNames: ['OAK', 'bark', 'oak'] });
    expect(byName(items, 'A').matchedTags).toEqual([
      { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
    expect(byName(items, 'C').matchedTags).toEqual([
      { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: true },
      { name: 'bark', displayName: 'bark', onAsset: true, onFiles: false },
    ]);
  });

  it('a tag on a pending file does not count as onFiles', async () => {
    const { make, addFile, tagAsset, tagFile, list } = await seed();
    const a = await make('A');
    await tagAsset(a.id, 'oak');
    await tagFile(await addFile(a.id, 'reference', 'image', 'a.png', 'pending'), 'oak');
    expect(byName(await list({ tagNames: ['oak'] }), 'A').matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
    ]);
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

describe('project list filters', () => {
  async function seed() {
    const ctx = await openSession();
    const { session } = ctx;
    const [type] = await listAssetTypes(session);
    const db = session.database;
    const project = (name: string, description = '') => createProject(session, { name, description });
    const member = async (projectId: string, name: string) => {
      const a = await createAsset(session, { name, typeId: type!.id });
      await assignAsset(session, { projectId, assetId: a.id });
      return a.id;
    };
    let n = 0;
    const addFile = async (
      assetId: string,
      originalName: string,
      kind: FileKind,
      status: 'complete' | 'failed' = 'complete',
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
      if (status === 'complete')
        await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      else await db.files.markFailed(id, 'x');
      await db.files.setPlacement(id, {
        relativePath: `assets/${assetId}/${originalName}`,
        assetId,
        role: 'reference',
      });
      return id;
    };
    const tagAsset = (assetId: string, name: string) =>
      db.tags.addToAsset({ assetId, name, displayName: name, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const tagFile = (fileId: string, name: string) =>
      db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: `t-${name}`, now: 'now' });
    const list = async (q: Partial<ProjectQuery>) =>
      (await listProjects(session, { limit: 60, offset: 0, ...q })).items;
    const names = async (q: Partial<ProjectQuery>) => (await list(q)).map((p) => p.name);
    return { session, project, member, addFile, tagAsset, tagFile, list, names };
  }

  it('query matches name or description, folded', async () => {
    const { project, names } = await seed();
    await project('Forest', 'Älter Wald');
    await project('Desert', 'sand');
    await project('Kältere Stadt');
    expect(await names({ query: 'alter' })).toEqual(['Forest', 'Kältere Stadt']);
    expect(await names({ query: 'WALD' })).toEqual(['Forest']);
    expect(await names({ query: 'ter wa' })).toEqual(['Forest']);
    expect(await names({ query: 'ocean' })).toEqual([]);
    expect(await names({ query: '   ' })).toEqual(['Desert', 'Forest', 'Kältere Stadt']);
  });

  it('status filters', async () => {
    const { session, project, names } = await seed();
    await project('A');
    const b = await project('B');
    await updateProject(session, b.id, { status: 'on_hold' });
    expect(await names({ status: 'on_hold' })).toEqual(['B']);
    expect(await names({ status: 'active' })).toEqual(['A']);
    expect(await names({ status: 'archived' })).toEqual([]);
  });

  it('a project matches only when one member asset carries all tags', async () => {
    const { session, project, member, addFile, tagAsset, tagFile } = await seed();
    const p1 = await project('P1');
    const x = await member(p1.id, 'X');
    await tagAsset(x, 'oak');
    await tagFile(await addFile(x, 'x.png', 'image'), 'bark');
    const other = await member(p1.id, 'W');
    await tagAsset(other, 'moss');
    const p2 = await project('P2');
    await tagAsset(await member(p2.id, 'Y'), 'oak');
    await tagAsset(await member(p2.id, 'Z'), 'bark');
    const p3 = await project('P3');
    const v = await member(p3.id, 'V');
    await tagAsset(v, 'oak');
    await tagFile(await addFile(v, 'v.png', 'image', 'failed'), 'bark');

    const { items, total } = await listProjects(session, { limit: 60, offset: 0, tagNames: ['oak', 'bark'] });
    expect(items.map((p) => p.name)).toEqual(['P1']);
    expect(total).toBe(1);
    expect(items[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
    const normalised = await listProjects(session, { limit: 60, offset: 0, tagNames: [' OAK ', 'oak'] });
    expect(normalised.items.map((p) => [p.name, p.matchedTags])).toEqual([
      ['P1', [{ name: 'oak', displayName: 'oak', onAsset: true, onFiles: false }]],
      ['P2', [{ name: 'oak', displayName: 'oak', onAsset: true, onFiles: false }]],
      ['P3', [{ name: 'oak', displayName: 'oak', onAsset: true, onFiles: false }]],
    ]);
  });

  it('matchedTags aggregate only over the member assets that carry all tags', async () => {
    const { project, member, addFile, tagAsset, tagFile, list } = await seed();
    const p = await project('P');
    await tagAsset(await member(p.id, 'A'), 'oak');
    const b = await member(p.id, 'B');
    await tagFile(await addFile(b, 'b.png', 'image'), 'oak');
    await tagFile(await addFile(b, 'c.png', 'image'), 'bark');
    expect((await list({ tagNames: ['oak'] }))[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: true },
    ]);
    // Only B carries both tags; A's asset tag does not count.
    expect((await list({ tagNames: ['oak', 'bark'] }))[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: false, onFiles: true },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
  });

  it('an unknown tag yields an empty page and an invalid tag name is rejected', async () => {
    const { session, project, member, tagAsset, names } = await seed();
    const p = await project('P');
    await tagAsset(await member(p.id, 'A'), 'oak');
    expect(await names({ tagNames: ['oak', 'nope'] })).toEqual([]);
    expect((await listProjects(session, { limit: 5, offset: 0, tagNames: ['nope'] })).total).toBe(0);
    await expect(listProjects(session, { limit: 5, offset: 0, tagNames: ['  '] })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('imageCount counts complete image files over member assets', async () => {
    const { project, member, addFile, list } = await seed();
    const p = await project('P');
    const a = await member(p.id, 'A');
    await addFile(a, 'a.png', 'image');
    await addFile(a, 'b.png', 'image', 'failed');
    await addFile(a, 'a.glb', 'model');
    await addFile(await member(p.id, 'B'), 'c.png', 'image');
    await project('Empty');
    expect((await list({})).map((x) => [x.name, x.assetCount, x.imageCount])).toEqual([
      ['Empty', 0, 0],
      ['P', 2, 2],
    ]);
  });

  it('without filters matchedTags is absent and pickers still work', async () => {
    const { session, project, member, tagAsset } = await seed();
    const p = await project('B');
    await tagAsset(await member(p.id, 'A'), 'oak');
    await project('A');
    const page = await listProjects(session, { limit: 200, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((x) => x.name)).toEqual(['A', 'B']);
    expect(page.items.every((x) => x.matchedTags === undefined)).toBe(true);
    expect(page.items.map((x) => x.imageCount)).toEqual([0, 0]);
    expect((await listProjects(session, { limit: 1, offset: 1 })).items.map((x) => x.name)).toEqual(['B']);
  });

  it('filters combine', async () => {
    const { session, project, member, tagAsset, names } = await seed();
    const a = await project('Oak forest');
    await tagAsset(await member(a.id, 'A'), 'oak');
    const b = await project('Oak grove');
    await tagAsset(await member(b.id, 'B'), 'oak');
    await updateProject(session, b.id, { status: 'archived' });
    await project('Oak hill');
    expect(await names({ query: 'oak', status: 'active', tagNames: ['oak'] })).toEqual(['Oak forest']);
  });
});
