import { describe, expect, it } from 'vitest';
import {
  InvalidOperationError,
  NotFoundError,
  WorkspaceManager,
  addRelation,
  assignAsset,
  createAsset,
  createProject,
  getAsset,
  listAssets,
  listAssignmentsOfAsset,
  listMembersOfProject,
  listProjects,
  listRelations,
  removeAssignment,
  removeRelation,
  updateAssignment,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

async function openSession() {
  const fake = createFakeHost();
  let tick = 0;
  // A fixed clock that advances by one minute per call.
  fake.host.now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++, 0));
  const manager = new WorkspaceManager(fake.host);
  await manager.create({ name: 'Demo', rootPath: '/ws/a' });
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await session.database.assetTypes.list())[0]!.id;
  const project = await createProject(session, { name: 'Game' });
  const asset = await createAsset(session, { name: 'Pump', typeId });
  const other = await createAsset(session, { name: 'Motel', typeId });
  return { session, typeId, project, asset, other };
}

describe('project assignments', () => {
  it('assigning twice returns the first assignment unchanged', async () => {
    const { session, project, asset } = await openSession();
    const key = { projectId: project.id, assetId: asset.id };
    const first = await assignAsset(session, key);
    expect(first).toMatchObject({
      ...key,
      priority: 'normal',
      approvalStatus: 'pending',
      intendedUse: '',
      notes: '',
    });
    expect(first.assignedAt).toBe(first.updatedAt);
    await updateAssignment(session, key, { priority: 'high' });
    const again = await assignAsset(session, key);
    expect(again.priority).toBe('high');
    expect(again.assignedAt).toBe(first.assignedAt);
    await expect(listAssignmentsOfAsset(session, asset.id)).resolves.toHaveLength(1);
  });

  it('assignAsset rejects an unknown project or asset with not_found', async () => {
    const { session, project, asset } = await openSession();
    await expect(assignAsset(session, { projectId: UNKNOWN_ID, assetId: asset.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignAsset(session, { projectId: project.id, assetId: UNKNOWN_ID })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignAsset(session, { projectId: UNKNOWN_ID, assetId: asset.id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updateAssignment changes project-specific data without touching the asset', async () => {
    const { session, project, asset } = await openSession();
    const key = { projectId: project.id, assetId: asset.id };
    const first = await assignAsset(session, key);
    const updated = await updateAssignment(session, key, {
      priority: 'high',
      approvalStatus: 'approved',
      intendedUse: 'hero prop',
      notes: 'check scale',
    });
    expect(updated).toMatchObject({ priority: 'high', approvalStatus: 'approved', intendedUse: 'hero prop', notes: 'check scale' });
    expect(updated.updatedAt > first.updatedAt).toBe(true);
    expect(updated.assignedAt).toBe(first.assignedAt);
    await expect(getAsset(session, asset.id)).resolves.toEqual(asset);
    await expect(
      updateAssignment(session, { projectId: project.id, assetId: UNKNOWN_ID }, { notes: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('removeAssignment is a no-op for a missing assignment and keeps the asset', async () => {
    const { session, project, asset } = await openSession();
    const key = { projectId: project.id, assetId: asset.id };
    await expect(removeAssignment(session, key)).resolves.toBeUndefined();
    await assignAsset(session, key);
    await removeAssignment(session, key);
    await expect(listAssignmentsOfAsset(session, asset.id)).resolves.toEqual([]);
    await expect(getAsset(session, asset.id)).resolves.toEqual(asset);
  });

  it('lists members and derives counts and the project filter', async () => {
    const { session, project, asset, other } = await openSession();
    await assignAsset(session, { projectId: project.id, assetId: asset.id });
    await assignAsset(session, { projectId: project.id, assetId: other.id });
    const members = await listMembersOfProject(session, project.id, { limit: 1, offset: 0 });
    expect(members.total).toBe(2);
    expect(members.items.map((m) => m.asset.name)).toEqual(['Motel']);
    expect((await listProjects(session, { limit: 10, offset: 0 })).items[0]!.assetCount).toBe(2);
    const filtered = await listAssets(session, { limit: 10, offset: 0, projectId: project.id });
    expect(filtered.items.map((a) => a.projectCount)).toEqual([1, 1]);
    await expect(listMembersOfProject(session, UNKNOWN_ID, { limit: 1, offset: 0 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAssignmentsOfAsset(session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('asset relations', () => {
  it('addRelation rejects a self-relation with invalid_operation', async () => {
    const { session, asset } = await openSession();
    await expect(addRelation(session, { fromAssetId: asset.id, toAssetId: asset.id, kind: 'uses' })).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });

  it('addRelation rejects an unknown asset with not_found', async () => {
    const { session, asset } = await openSession();
    await expect(addRelation(session, { fromAssetId: asset.id, toAssetId: UNKNOWN_ID, kind: 'uses' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(addRelation(session, { fromAssetId: UNKNOWN_ID, toAssetId: asset.id, kind: 'uses' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('adding a relation twice keeps one and returns the first', async () => {
    const { session, asset, other } = await openSession();
    const key = { fromAssetId: asset.id, toAssetId: other.id, kind: 'part_of' as const };
    const first = await addRelation(session, key);
    const again = await addRelation(session, key);
    expect(again).toEqual(first);
    await expect(listRelations(session, asset.id)).resolves.toHaveLength(1);
  });

  it('listRelations shows the relation from both sides', async () => {
    const { session, asset, other } = await openSession();
    await addRelation(session, { fromAssetId: asset.id, toAssetId: other.id, kind: 'uses' });
    const a = await listRelations(session, asset.id);
    const b = await listRelations(session, other.id);
    expect(a).toMatchObject([{ direction: 'outgoing', kind: 'uses', other: { id: other.id } }]);
    expect(b).toMatchObject([{ direction: 'incoming', kind: 'uses', other: { id: asset.id } }]);
    await expect(listRelations(session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('removeRelation removes it and is a no-op when missing', async () => {
    const { session, asset, other } = await openSession();
    const key = { fromAssetId: asset.id, toAssetId: other.id, kind: 'uses' as const };
    await addRelation(session, key);
    await removeRelation(session, key);
    await expect(removeRelation(session, key)).resolves.toBeUndefined();
    await expect(listRelations(session, asset.id)).resolves.toEqual([]);
  });
});
