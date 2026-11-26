import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcResult } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type HostActions, type IpcHandlers } from '../src/main/ipc.js';
import { idleJobHost } from './idle-job-host.js';

let base: string;
let root: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;
const openPath = vi.fn<(absolutePath: string) => Promise<string>>();
const showItemInFolder = vi.fn<(absolutePath: string) => void>();
const workspaceOpened = vi.fn<() => Promise<void>>();
const workspaceClosing = vi.fn<() => Promise<void>>();
const host: HostActions = { openPath, showItemInFolder, workspaceOpened, workspaceClosing };

beforeEach(async () => {
  openPath.mockReset().mockResolvedValue('');
  showItemInFolder.mockReset();
  workspaceOpened.mockReset().mockResolvedValue();
  workspaceClosing.mockReset().mockResolvedValue();
  base = await mkdtemp(join(tmpdir(), 'af-shell-ipc-'));
  root = join(base, 'workspace');
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  handlers = createWorkspaceHandlers(
    manager,
    {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWorkflow: async () => false,
    },
    host,
    idleJobHost,
  );
});
afterEach(async () => {
  await manager.close();
  await rm(base, { recursive: true, force: true });
});

const call = (channel: IpcChannel, request: unknown) => dispatch(handlers, channel, request);
async function ok<T = any>(channel: IpcChannel, request: unknown): Promise<T> {
  const result = await call(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
  return result.value as T;
}

async function setup(name: string) {
  const summary = await ok<{ id: string }>('workspace:create', { name: 'Test', rootPath: root });
  const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
  const asset = await ok<{ id: string }>('assets:create', { name: 'A', typeId: type!.id });
  const source = join(base, name);
  await writeFile(source, 'data');
  const [result] = await ok<{ file: { id: string; relativePath: string } }[]>('files:import', {
    sourcePaths: [source],
    target: { assetId: asset.id, role: 'reference' },
  });
  return { summary, asset, file: result!.file };
}

function messageOf(result: IpcResult<unknown>): string {
  if (result.ok) throw new Error('expected a failure');
  return result.error.message;
}

describe('file shell IPC', () => {
  it('opens an allowed file with its absolute path inside the workspace', async () => {
    const { file } = await setup('model.blend');
    const result = await call('files:openExternal', { fileId: file.id });
    expect(result).toEqual({ ok: true, value: null });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath.mock.calls[0]![0].startsWith(root)).toBe(true);
  });

  it('a file outside the allow-list is never handed to the shell', async () => {
    const { file } = await setup('Archive.ZIP');
    // Programs and installers cannot be imported at all (core import tests); an archive imports
    // but is not openable. Upper case exercises the case-insensitive check.
    const result = await call('files:openExternal', { fileId: file.id });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(openPath).not.toHaveBeenCalled();
    expect(await call('files:showInFolder', { fileId: file.id })).toEqual({ ok: true, value: null });
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('a file missing on disk is not_found', async () => {
    const { file } = await setup('model.blend');
    await rm(join(root, file.relativePath));
    expect(await call('files:openExternal', { fileId: file.id })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('unreachable storage is storage_unreachable', async () => {
    // A missing root next to an existing parent counts as reachable (empty), so the parent
    // goes away too, like an unmounted share.
    root = join(base, 'mount', 'workspace');
    await mkdir(join(base, 'mount'));
    const { file } = await setup('model.blend');
    await rename(join(base, 'mount'), join(base, 'moved-away'));
    expect(await call('files:openExternal', { fileId: file.id })).toMatchObject({
      ok: false,
      error: { code: 'storage_unreachable' },
    });
    expect(await call('files:showInFolder', { fileId: file.id })).toMatchObject({
      ok: false,
      error: { code: 'storage_unreachable' },
    });
  });

  it('a shell failure becomes invalid_operation without the shell text', async () => {
    const { file } = await setup('model.blend');
    openPath.mockResolvedValue('Access is denied C:\\x');
    const result = await call('files:openExternal', { fileId: file.id });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
    expect(messageOf(result)).not.toContain('Access is denied');
    expect(messageOf(result)).not.toContain('C:');
  });

  it('no forwarded error message contains an absolute path', async () => {
    root = join(base, 'mount', 'workspace');
    await mkdir(join(base, 'mount'));
    const { file } = await setup('model.blend');
    openPath.mockResolvedValue(`failed ${root}`);
    const messages = [messageOf(await call('files:openExternal', { fileId: file.id }))];
    await rm(join(root, file.relativePath));
    messages.push(messageOf(await call('files:openExternal', { fileId: file.id })));
    messages.push(messageOf(await call('files:showInFolder', { fileId: file.id })));
    await rename(join(base, 'mount'), join(base, 'moved-away'));
    messages.push(messageOf(await call('files:openExternal', { fileId: file.id })));
    for (const message of messages) {
      expect(message).not.toContain(root);
      expect(message).not.toContain(root.replaceAll('\\', '/'));
      expect(message).not.toContain(base);
    }
  });

  it('workspace:open and workspace:create call workspaceOpened once each', async () => {
    await ok('workspace:create', { name: 'Test', rootPath: root });
    expect(workspaceOpened).toHaveBeenCalledTimes(1);
    await ok('workspace:close', {});
    await ok('workspace:open', { rootPath: root });
    expect(workspaceOpened).toHaveBeenCalledTimes(2);
  });

  it('a throwing workspaceOpened hook does not fail open or create', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    workspaceOpened.mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    expect(await call('workspace:create', { name: 'Test', rootPath: root })).toMatchObject({ ok: true });
    await ok('workspace:close', {});
    expect(await call('workspace:open', { rootPath: root })).toMatchObject({ ok: true });
    expect(workspaceOpened).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('workspaceOpened is not called when open or create fails', async () => {
    expect(await call('workspace:open', { rootPath: join(base, 'does-not-exist') })).toMatchObject({ ok: false });
    await mkdir(join(base, 'not-a-workspace', 'sub'), { recursive: true });
    await writeFile(join(base, 'not-a-workspace', 'file.txt'), 'x');
    expect(await call('workspace:create', { name: 'Test', rootPath: join(base, 'not-a-workspace') })).toMatchObject({
      ok: false,
    });
    expect(workspaceOpened).not.toHaveBeenCalled();
  });

  it('lifecycle channels call workspaceClosing before the manager and workspaceOpened only while one is open', async () => {
    const order: string[] = [];
    workspaceClosing.mockImplementation(async () => {
      order.push(`closing:${manager.current()?.name ?? 'none'}`);
    });
    workspaceOpened.mockImplementation(async () => {
      order.push(`opened:${manager.current()?.name ?? 'none'}`);
    });
    await ok('workspace:create', { name: 'Test', rootPath: root });
    await ok('workspace:close', {});
    await ok('workspace:open', { rootPath: root });
    expect(await call('workspace:open', { rootPath: join(base, 'does-not-exist') })).toMatchObject({ ok: false });
    expect(order).toEqual(['closing:none', 'opened:Test', 'closing:Test', 'closing:none', 'opened:Test', 'closing:Test']);
  });

  it('runs concurrent lifecycle channels one after the other', async () => {
    const order: string[] = [];
    workspaceClosing.mockImplementation(async () => {
      order.push(`closing:${manager.current()?.name ?? 'none'}`);
    });
    workspaceOpened.mockImplementation(async () => {
      order.push(`opened:${manager.current()?.name ?? 'none'}`);
    });
    await Promise.all([ok('workspace:create', { name: 'Test', rootPath: root }), ok('workspace:close', {})]);
    expect(order).toEqual(['closing:none', 'opened:Test', 'closing:Test']);
  });

  it('assets:setCover returns the detail and rejects a foreign file', async () => {
    const { asset, file } = await setup('pic.png');
    const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
    const other = await ok('assets:create', { name: 'B', typeId: type!.id });

    const detail = await ok('assets:setCover', { assetId: asset.id, fileId: file.id });
    expect(detail).toMatchObject({ id: asset.id });
    expect(await ok('assets:get', { id: asset.id })).toEqual(detail);

    expect(await call('assets:setCover', { assetId: other.id, fileId: file.id })).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(await ok('assets:setCover', { assetId: asset.id, fileId: null })).toMatchObject({ id: asset.id });
  });
});
