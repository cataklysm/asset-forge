import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ASSET_TYPES,
  NotFoundError,
  WorkspaceManager,
  createAsset,
  createProject,
  getAsset,
  listAssetTypes,
  updateAsset,
  updateProject,
  type WorkspaceSession,
} from '../src/index.js';
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
