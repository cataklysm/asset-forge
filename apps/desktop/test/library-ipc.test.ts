import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcContract, type IpcChannel } from '@assetforge/contracts';
import { assetFilePath, type WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';

let base: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-lib-ipc-'));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  handlers = createWorkspaceHandlers(manager, {
    pickDirectory: async () => null,
    pickFiles: async () => [],
    confirmRemoveWorkspace: async () => 'cancel',
  });
});
afterEach(async () => {
  await manager.close();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

async function call(channel: IpcChannel, request: unknown) {
  return dispatch(handlers, channel, request);
}

async function ok<T = any>(channel: IpcChannel, request: unknown): Promise<T> {
  const result = await call(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
  return result.value as T;
}

async function openWorkspace() {
  await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
}

const page = { limit: 10, offset: 0 };

describe('library IPC', () => {
  it('returns no_workspace_open for every library channel when nothing is open', async () => {
    const requests: Partial<Record<IpcChannel, unknown>> = {
      'assetTypes:list': {},
      'projects:list': page,
      'projects:get': { id: uuid },
      'projects:create': { name: 'P' },
      'projects:update': { id: uuid, patch: { name: 'Q' } },
      'assets:list': page,
      'assets:get': { id: uuid },
      'assets:create': { name: 'A', typeId: uuid },
      'assets:update': { id: uuid, patch: { name: 'B' } },
      'assignments:listByAsset': { assetId: uuid },
      'assignments:listByProject': { ...page, projectId: uuid },
      'assignments:assign': { projectId: uuid, assetId: uuid },
      'assignments:update': { projectId: uuid, assetId: uuid, patch: { priority: 'high' } },
      'assignments:remove': { projectId: uuid, assetId: uuid },
      'relations:list': { assetId: uuid },
      'relations:add': { fromAssetId: uuid, toAssetId: uuid, kind: 'uses' },
      'relations:remove': { fromAssetId: uuid, toAssetId: uuid, kind: 'uses' },
      'files:list': { ...page, scope: { kind: 'inbox' } },
      'files:import': { sourcePaths: [join(base, 'x.png')] },
      'files:assign': { fileId: uuid, assetId: uuid, role: 'reference' },
      'files:unassign': { fileId: uuid },
    };
    expect(Object.keys(requests)).toHaveLength(21);
    for (const [channel, request] of Object.entries(requests)) {
      expect(ipcContract[channel as IpcChannel].request.safeParse(request).success, channel).toBe(true);
      expect(await call(channel as IpcChannel, request), channel).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    }
  });

  it('creates and lists an asset through IPC', async () => {
    await openWorkspace();
    const types = await ok<{ id: string; key: string }[]>('assetTypes:list', {});
    const typeId = types.find((t) => t.key === 'character')!.id;
    const created = await ok('assets:create', { name: ' Pump ', typeId });
    expect(created).toMatchObject({ name: 'Pump', typeId, status: 'draft' });

    const listed = await ok('assets:list', { ...page, nameContains: 'pum' });
    expect(ipcContract['assets:list'].response.safeParse(listed).success).toBe(true);
    expect(listed.items).toMatchObject([{ id: created.id, projectCount: 0, fileCount: 0 }]);

    const percent = await ok('assets:list', { ...page, nameContains: '%' });
    expect(percent).toEqual({ items: [], total: 0 });
  });

  it('maps an unknown asset to not_found', async () => {
    await openWorkspace();
    expect(await call('assets:get', { id: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('maps a self-relation to invalid_operation', async () => {
    await openWorkspace();
    const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
    const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
    const result = await call('relations:add', { fromAssetId: asset.id, toAssetId: asset.id, kind: 'uses' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('assigns a file to an asset and reports a failing move as invalid_operation without paths', async () => {
    await openWorkspace();
    const root = join(base, 'workspace');
    const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
    const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
    const sources = [join(base, 'a.png'), join(base, 'b.png')];
    await writeFile(sources[0]!, 'a');
    await writeFile(sources[1]!, 'b');
    const [first, second] = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: sources });

    const placed = await ok('files:assign', { fileId: first!.file.id, assetId: asset.id, role: 'reference' });
    expect(placed).toMatchObject({
      assetId: asset.id,
      role: 'reference',
      relativePath: assetFilePath(asset.id, 'reference', first!.file.id, 'a.png'),
    });

    const occupied = join(root, assetFilePath(asset.id, 'reference', second!.file.id, 'b.png'));
    await mkdir(join(occupied, '..'), { recursive: true });
    await writeFile(occupied, 'other');
    const result = await call('files:assign', { fileId: second!.file.id, assetId: asset.id, role: 'reference' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
    const message = result.ok ? '' : result.error.message;
    expect(message).not.toContain(base);
    expect(message).not.toMatch(/[A-Za-z]:\\|\/|\\/);
  });

  it('rejects a whitespace-only project name as invalid_request', async () => {
    await openWorkspace();
    expect(await call('projects:create', { name: '  ' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
