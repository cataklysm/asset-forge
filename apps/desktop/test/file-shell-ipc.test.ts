import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcResult } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type HostActions, type IpcHandlers } from '../src/main/ipc.js';

interface WritableRawDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}
const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => WritableRawDatabase;

let base: string;
let root: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;
const openPath = vi.fn<(absolutePath: string) => Promise<string>>();
const showItemInFolder = vi.fn<(absolutePath: string) => void>();
const workspaceOpened = vi.fn<() => void>();
const host: HostActions = { openPath, showItemInFolder, workspaceOpened };

beforeEach(async () => {
  openPath.mockReset().mockResolvedValue('');
  showItemInFolder.mockReset();
  workspaceOpened.mockReset();
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
  const summary = await ok('workspace:create', { name: 'Test', rootPath: root });
  const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
  const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
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

  it('a blocked file is never handed to the shell', async () => {
    const { summary, file } = await setup('Setup.EXE');
    // Windows cannot create a file named "Setup.EXE." (it strips the trailing dot), so the
    // stored original name is rewritten in the database while the workspace is closed. The
    // on-disk name stays the sanitised one, as an import would have produced it.
    await ok('workspace:close', {});
    const db = new Database(join(base, 'userData', 'workspaces', summary.id, 'assetforge.sqlite'));
    db.prepare('UPDATE file SET original_name = ? WHERE id = ?').run('Setup.EXE.', file.id);
    db.close();
    await ok('workspace:open', { rootPath: root });

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
