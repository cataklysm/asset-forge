import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';

let base: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;

const dialogs = {
  pickDirectory: async () => null,
  pickFiles: async () => [],
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-ipc-'));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  handlers = createWorkspaceHandlers(manager, dialogs);
});
afterEach(async () => {
  await manager.close();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe('dispatch', () => {
  it('rejects an unknown channel', async () => {
    const result = await dispatch(handlers, 'fs:readAnything', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });
  });

  it('rejects inherited object keys as channels', async () => {
    const result = await dispatch(handlers, 'toString', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });
  });

  it('rejects a request that fails its schema', async () => {
    const result = await dispatch(handlers, 'files:list', { limit: 0, offset: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('maps an AssetForgeError to its code', async () => {
    const result = await dispatch(handlers, 'files:list', { limit: 10, offset: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
  });

  it('lists the files of a freshly created workspace', async () => {
    const created = await dispatch(handlers, 'workspace:create', {
      name: 'Test',
      rootPath: join(base, 'workspace'),
    });
    expect(created).toMatchObject({ ok: true, value: { name: 'Test' } });

    const result = await dispatch(handlers, 'files:list', { limit: 10, offset: 0 });
    expect(result).toEqual({ ok: true, value: { items: [], total: 0 } });
  });

  it('routes dialog channels to the injected dialogs', async () => {
    const picked = createWorkspaceHandlers(manager, {
      pickDirectory: async () => 'D:\\picked',
      pickFiles: async () => ['D:\\a.png'],
    });
    expect(await dispatch(picked, 'dialog:pickDirectory', {})).toEqual({ ok: true, value: 'D:\\picked' });
    expect(await dispatch(picked, 'dialog:pickFiles', {})).toEqual({ ok: true, value: ['D:\\a.png'] });
  });

  it('hides unexpected errors behind internal_error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: IpcHandlers = {
      ...handlers,
      'workspace:list': async () => {
        throw new Error('secret path C:\\x');
      },
    };
    const result = await dispatch(failing, 'workspace:list', {});
    expect(result).toEqual({ ok: false, error: { code: 'internal_error', message: 'Unexpected error' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(log).toHaveBeenCalled();
  });

  it('rejects a handler response that violates the contract', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      ...handlers,
      'dialog:pickDirectory': async () => 42,
    } as unknown as IpcHandlers;
    const result = await dispatch(broken, 'dialog:pickDirectory', {});
    expect(result).toEqual({ ok: false, error: { code: 'internal_error', message: 'Unexpected error' } });
    expect(log).toHaveBeenCalled();
  });
});
