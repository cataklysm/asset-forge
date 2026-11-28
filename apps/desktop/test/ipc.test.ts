import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import type { Dialogs, RemoveChoice } from '../src/main/host-actions.js';
import { dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { createWorkspaceHandlers } from '../src/main/workspace-handlers.js';
import { idleJobHost, idleServices, noopHost } from './idle-job-host.js';

let base: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;

let choice: RemoveChoice = 'cancel';

const dialogs: Dialogs = {
  pickDirectory: async () => null,
  pickFiles: async () => [],
  confirmRemoveWorkspace: async () => choice,
  confirmRemoveWorkflow: async () => false,
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-ipc-'));
  choice = 'cancel';
  manager = createWorkspaceManager({
    userDataPath: join(base, 'userData'),
    migrationsFolder: MIGRATIONS_FOLDER,
    // Stands in for the OS trash: the folder ends up next to the workspaces, not deleted.
    moveToTrash: async (path) => {
      await mkdir(join(base, 'trash'), { recursive: true });
      await rename(path, join(base, 'trash', basename(path)));
    },
  });
  handlers = createWorkspaceHandlers(manager, dialogs, noopHost, idleJobHost, idleServices);
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
    const result = await dispatch(handlers, 'files:list', { limit: 0, offset: 0, scope: { kind: 'all' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('maps an AssetForgeError to its code', async () => {
    const result = await dispatch(handlers, 'files:list', { limit: 10, offset: 0, scope: { kind: 'all' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
  });

  it('lists the files of a freshly created workspace', async () => {
    const created = await dispatch(handlers, 'workspace:create', {
      name: 'Test',
      rootPath: join(base, 'workspace'),
    });
    expect(created).toMatchObject({ ok: true, value: { name: 'Test' } });

    const result = await dispatch(handlers, 'files:list', { limit: 10, offset: 0, scope: { kind: 'all' } });
    expect(result).toEqual({ ok: true, value: { items: [], total: 0 } });
  });

  it('routes dialog channels to the injected dialogs', async () => {
    const picked = createWorkspaceHandlers(
      manager,
      {
        pickDirectory: async () => 'D:\\picked',
        pickFiles: async () => ['D:\\a.png'],
        confirmRemoveWorkspace: async () => 'cancel',
        confirmRemoveWorkflow: async () => false,
      },
      noopHost,
      idleJobHost,
      idleServices,
    );
    expect(await dispatch(picked, 'dialog:pickDirectory', {})).toEqual({ ok: true, value: 'D:\\picked' });
    expect(await dispatch(picked, 'dialog:pickFiles', {})).toEqual({ ok: true, value: ['D:\\a.png'] });
  });

  it('hides unexpected errors behind internal_error', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      ...handlers,
      'dialog:pickDirectory': async () => 42,
    } as unknown as IpcHandlers;
    const result = await dispatch(broken, 'dialog:pickDirectory', {});
    expect(result).toEqual({ ok: false, error: { code: 'internal_error', message: 'Unexpected error' } });
    expect(log).toHaveBeenCalled();
  });
});

describe('workspace:resolveCreatePath', () => {
  it('puts a folder named after the workspace inside the chosen location', async () => {
    const result = await dispatch(handlers, 'workspace:resolveCreatePath', {
      name: 'Gilded Hour',
      parentPath: base,
    });
    expect(result).toEqual({ ok: true, value: join(base, 'Gilded Hour') });
  });

  it('never resolves outside the chosen location', async () => {
    const result = await dispatch(handlers, 'workspace:resolveCreatePath', {
      name: '..\\..\\escape',
      parentPath: base,
    });
    expect(result).toEqual({ ok: true, value: join(base, '_.._escape') });
  });

  it('creates the workspace in the resolved folder', async () => {
    const resolved = await dispatch(handlers, 'workspace:resolveCreatePath', {
      name: 'Nested',
      parentPath: base,
    });
    if (!resolved.ok) throw new Error('resolve failed');
    const created = await dispatch(handlers, 'workspace:create', {
      name: 'Nested',
      rootPath: resolved.value,
    });
    expect(created).toMatchObject({ ok: true, value: { name: 'Nested', rootPath: join(base, 'Nested') } });
  });
});

describe('workspace:remove', () => {
  async function createWorkspace(): Promise<{ id: string; rootPath: string }> {
    const rootPath = join(base, 'Demo');
    const created = await dispatch(handlers, 'workspace:create', { name: 'Demo', rootPath });
    if (!created.ok) throw new Error('create failed');
    return { id: (created.value as { id: string }).id, rootPath };
  }

  /** True while anything below userData still carries the workspace id in its name. */
  async function hasLocalData(id: string): Promise<boolean> {
    const names = await readdir(join(base, 'userData'), { recursive: true });
    return names.some((name) => name.includes(id));
  }

  it('changes nothing when the user cancels', async () => {
    const { id, rootPath } = await createWorkspace();
    const result = await dispatch(handlers, 'workspace:remove', { id });
    expect(result).toEqual({ ok: true, value: { removed: false, folderTrashed: false } });
    expect(await manager.list()).toHaveLength(1);
    expect(manager.current()?.id).toBe(id);
    expect(await hasLocalData(id)).toBe(true);
    expect(existsSync(rootPath)).toBe(true);
  });

  it('forgets the workspace and deletes its database but keeps the folder', async () => {
    const { id, rootPath } = await createWorkspace();
    choice = 'forget';
    const result = await dispatch(handlers, 'workspace:remove', { id });
    expect(result).toEqual({ ok: true, value: { removed: true, folderTrashed: false } });
    expect(await manager.list()).toEqual([]);
    expect(manager.current()).toBeNull();
    expect(await hasLocalData(id)).toBe(false);
    expect(existsSync(join(rootPath, 'workspace.json'))).toBe(true);
  });

  it('moves the folder to the trash when the user asks for it', async () => {
    const { id, rootPath } = await createWorkspace();
    choice = 'forget_and_trash_folder';
    const result = await dispatch(handlers, 'workspace:remove', { id });
    expect(result).toEqual({ ok: true, value: { removed: true, folderTrashed: true } });
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(join(base, 'trash', 'Demo', 'workspace.json'))).toBe(true);
    expect(await hasLocalData(id)).toBe(false);
    expect(await manager.list()).toEqual([]);
  });

  it('lets the same folder be used for a new workspace afterwards', async () => {
    const { id, rootPath } = await createWorkspace();
    choice = 'forget_and_trash_folder';
    await dispatch(handlers, 'workspace:remove', { id });
    const again = await dispatch(handlers, 'workspace:create', { name: 'Demo', rootPath });
    expect(again).toMatchObject({ ok: true, value: { name: 'Demo' } });
  });

  describe('lifecycle notifications', () => {
    function recordingHandlers(): string[] {
      const calls: string[] = [];
      const host = {
        ...noopHost,
        workspaceOpened: async () => void calls.push('opened'),
        workspaceClosing: async () => void calls.push('closing'),
      };
      handlers = createWorkspaceHandlers(manager, dialogs, host, idleJobHost, idleServices);
      return calls;
    }

    it('leaves the open workspace alone when another one is removed', async () => {
      const calls = recordingHandlers();
      const { id } = await createWorkspace();
      const other = await dispatch(handlers, 'workspace:create', { name: 'Other', rootPath: join(base, 'Other') });
      if (!other.ok) throw new Error('create failed');
      const otherId = (other.value as { id: string }).id;
      calls.length = 0;
      choice = 'forget';
      const result = await dispatch(handlers, 'workspace:remove', { id });
      expect(result).toEqual({ ok: true, value: { removed: true, folderTrashed: false } });
      expect(calls).toEqual([]);
      expect(manager.current()?.id).toBe(otherId);
    });

    it('notifies closing and opened as before when the open workspace is removed', async () => {
      const calls = recordingHandlers();
      const { id } = await createWorkspace();
      calls.length = 0;
      choice = 'forget';
      await dispatch(handlers, 'workspace:remove', { id });
      expect(calls).toEqual(['closing']);
    });
  });

  it('removes nothing for an unknown id', async () => {
    const { id } = await createWorkspace();
    choice = 'forget_and_trash_folder';
    const result = await dispatch(handlers, 'workspace:remove', {
      id: '33333333-3333-4333-8333-333333333333',
    });
    expect(result).toEqual({ ok: true, value: { removed: false, folderTrashed: false } });
    expect(manager.current()?.id).toBe(id);
  });

  it('rejects a request without a valid id', async () => {
    const result = await dispatch(handlers, 'workspace:remove', { id: '../x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
