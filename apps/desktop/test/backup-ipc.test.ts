import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DAMAGED_MESSAGE,
  BACKUP_STALE_MESSAGE,
  DATABASE_MISSING_MESSAGE,
  LOCATION_IN_WORKSPACE_MESSAGE,
  type BackupListing,
  type BackupStatus,
} from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import type { Dialogs, HostActions } from '../src/main/host-actions.js';
import { dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { JsonWorkspaceRegistry } from '../src/main/json-registry.js';
import { RunningRestores } from '../src/main/running-restores.js';
import { createWorkspaceHandlers } from '../src/main/workspace-handlers.js';
import { TEST_BACKUP_WORKER_URL } from './backup-worker.js';
import { idleJobHost, idleServices, noopHost } from './idle-job-host.js';

let base: string;
let userData: string;
let registry: JsonWorkspaceRegistry;
let manager: WorkspaceManager;
let handlers: IpcHandlers;
let picked: string | null;
/** Every answer of the test, checked for paths at the end of each test. */
let answers: unknown[];
let logLines: string[];
let restores: RunningRestores;
/** While set, every lifecycle step waits for it in its closing notification, which holds the lifecycle queue. */
let closingGate: { promise: Promise<void>; release: () => void } | null;

const dialogs: Dialogs = {
  pickDirectory: async () => picked,
  pickFiles: async () => [],
  confirmRemoveWorkspace: async () => 'forget',
  confirmRemoveWithoutBackup: async () => false,
  confirmRemoveWorkflow: async () => false,
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-backup-ipc-'));
  userData = join(base, 'userData');
  picked = null;
  answers = [];
  logLines = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void logLines.push(String(line)));
  registry = new JsonWorkspaceRegistry(join(userData, 'settings.json'));
  manager = createWorkspaceManager({
    userDataPath: userData,
    migrationsFolder: MIGRATIONS_FOLDER,
    registry,
    backupWorkerUrl: TEST_BACKUP_WORKER_URL,
  });
  restores = new RunningRestores();
  closingGate = null;
  const host: HostActions = { ...noopHost, workspaceClosing: async () => closingGate?.promise };
  const backup = { registry, userDataPath: userData, restores };
  handlers = createWorkspaceHandlers(manager, dialogs, host, idleJobHost, { ...idleServices, backup });
});

afterEach(async () => {
  await manager.close();
  // No error, no attempt message and no log line ever names a path of the test.
  for (const text of [...answers.map(messageOf), ...logLines]) {
    expect(text).not.toContain(JSON.stringify(base).slice(1, -1));
    expect(text).not.toContain(base);
  }
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

/**
 * The text of an answer that is a message: the error of a failed request, or the message of a backup attempt.
 * Records such as a workspace carry their own folder on purpose and are not messages.
 *
 * @param answer one dispatched answer
 * @returns the message text, empty when the answer has none
 */
function messageOf(answer: unknown): string {
  const result = answer as { ok: boolean; value?: { message?: unknown }; error?: unknown };
  if (!result.ok) return JSON.stringify(result.error);
  return typeof result.value?.message === 'string' ? result.value.message : '';
}

/**
 * Sends one request and keeps the answer for the path check.
 *
 * @param channel the channel
 * @param request the request
 * @returns the answer
 */
async function send(channel: string, request: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
  const result = await dispatch(handlers, channel, request);
  answers.push(result);
  return result as { ok: boolean; value?: unknown; error?: unknown };
}

/**
 * Sends one request that must succeed.
 *
 * @param channel the channel
 * @param request the request
 * @returns the value
 */
async function value<T>(channel: string, request: unknown): Promise<T> {
  const result = await send(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

/**
 * Creates and opens a workspace.
 *
 * @param name its name, also its folder below the test directory
 * @returns its id and folder
 */
async function createWorkspace(name: string): Promise<{ id: string; rootPath: string }> {
  const rootPath = join(base, name);
  const created = await value<{ id: string }>('workspace:create', { name, rootPath });
  return { id: created.id, rootPath };
}

/**
 * Deletes the local database of a closed workspace, as if the machine had lost it.
 *
 * @param id the workspace
 */
async function loseDatabase(id: string): Promise<void> {
  await rm(join(userData, 'workspaces', id), { recursive: true, force: true });
}

/**
 * The project names of the open workspace.
 *
 * @returns the names
 */
async function projectNames(): Promise<string[]> {
  const list = await value<{ items: { name: string }[] }>('projects:list', { offset: 0, limit: 50 });
  return list.items.map((project) => project.name);
}

describe('backup location', () => {
  it('refuses a folder inside a workspace and stores nothing', async () => {
    const { id, rootPath } = await createWorkspace('Own');
    picked = join(rootPath, 'sub');
    await mkdir(picked);
    const result = await send('backup:changeLocation', {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed', message: LOCATION_IN_WORKSPACE_MESSAGE },
    });
    expect(await registry.backupDirectory(id)).toBeNull();
  });

  it('a cancelled pick answers null and changes nothing', async () => {
    const { id } = await createWorkspace('Own');
    expect(await send('backup:changeLocation', {})).toEqual({ ok: true, value: null });
    expect(await registry.backupDirectory(id)).toBeNull();
  });

  it('a chosen folder is stored and shown; reset returns to the default place', async () => {
    const { id } = await createWorkspace('Own');
    picked = join(base, 'elsewhere');
    await mkdir(picked);
    const changed = await value<BackupStatus>('backup:changeLocation', {});
    expect(changed.location).toEqual({ kind: 'chosen', path: picked });
    expect(await registry.backupDirectory(id)).toBe(picked);
    const attempt = await value<{ ok: boolean }>('backup:now', {});
    expect(attempt.ok).toBe(true);
    expect((await value<BackupStatus>('backup:status', {})).count).toBe(1);
    const reset = await value<BackupStatus>('backup:resetLocation', {});
    expect(reset.location).toEqual({ kind: 'workspace', path: null });
    expect(await registry.backupDirectory(id)).toBeNull();
  });

  it('an unreachable folder fails the backup with its fixed message and lists as unreachable', async () => {
    const { id } = await createWorkspace('Own');
    await registry.setBackupDirectory(id, join(base, 'gone'));
    const attempt = await value<{ ok: boolean; code: string; message: string }>('backup:now', {});
    expect(attempt).toMatchObject({
      ok: false,
      code: 'backup_location_unreachable',
      message: 'The backup folder cannot be reached',
    });
    const status = await manager.backupStatus();
    expect(status.reachable).toBe(false);
    const listing = await value<BackupListing>('workspace:backups', { id });
    expect(listing.unreachable).toBe(true);
  });
});

describe('backup ids', () => {
  it('an unknown id answers Load the backups again', async () => {
    const { rootPath } = await createWorkspace('Own');
    expect(await send('backup:delete', { backupId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'invalid_operation', message: BACKUP_STALE_MESSAGE },
    });
    await value('workspace:close', {});
    expect(await send('workspace:restore', { rootPath, backupId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'invalid_operation', message: BACKUP_STALE_MESSAGE },
    });
  });

  it('an id from another workspace is stale', async () => {
    const first = await createWorkspace('First');
    const second = await createWorkspace('Second');
    const listing = await value<BackupListing>('workspace:backups', { id: first.id });
    expect(listing.backups.length).toBeGreaterThan(0);
    await value('workspace:close', {});
    const result = await send('workspace:restore', {
      rootPath: second.rootPath,
      backupId: listing.backups[0]!.backupId,
    });
    expect(result).toMatchObject({ ok: false, error: { message: BACKUP_STALE_MESSAGE } });
  });

  it('a backup of the own lineage cannot be deleted through its restore id', async () => {
    const { id } = await createWorkspace('Own');
    await value('backup:now', {});
    const listing = await value<BackupListing>('workspace:backups', { id });
    const own = listing.backups.find((backup) => backup.sameLineage);
    expect(own).toBeDefined();
    const result = await send('backup:delete', { backupId: own!.backupId });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation', message: BACKUP_STALE_MESSAGE } });
    expect((await value<BackupListing>('workspace:backups', { id })).backups).toHaveLength(listing.backups.length);
  });

  it('refuses requests carrying a path field', async () => {
    const { rootPath } = await createWorkspace('Own');
    const backupId = randomUUID();
    for (const [channel, request] of [
      ['workspace:restore', { rootPath, backupId, directory: base }],
      ['workspace:backups', { rootPath, path: base }],
      ['backup:delete', { backupId, directory: base }],
      ['backup:changeLocation', { path: base }],
      ['backup:now', { directory: base }],
    ] as const) {
      expect(await dispatch(handlers, channel, request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
  });
});

describe('restore through IPC', () => {
  it('brings a lost database back from the backup written on close', async () => {
    const { id, rootPath } = await createWorkspace('Own');
    await value('projects:create', { name: 'Kept project' });
    await value('workspace:close', {});
    await loseDatabase(id);

    expect(await send('workspace:open', { rootPath })).toMatchObject({
      ok: false,
      error: { code: 'workspace_database_missing', message: DATABASE_MISSING_MESSAGE },
    });
    const listing = await value<BackupListing>('workspace:backups', { rootPath });
    expect(listing.unreachable).toBe(false);
    expect(listing.backups.length).toBeGreaterThan(0);

    const restored = await value<{ id: string }>('workspace:restore', {
      rootPath,
      backupId: listing.backups[0]!.backupId,
    });
    expect(restored.id).toBe(id);
    expect(await projectNames()).toEqual(['Kept project']);
    // The ids of a listing are used up by the restore.
    await value('workspace:close', {});
    expect(await send('workspace:restore', { rootPath, backupId: listing.backups[0]!.backupId })).toMatchObject({
      ok: false,
      error: { message: BACKUP_STALE_MESSAGE },
    });
  });

  it('refuses a damaged backup and leaves the database as it was', async () => {
    const { id, rootPath } = await createWorkspace('Own');
    await value('projects:create', { name: 'Current' });
    await value('backup:now', {});
    const directory = join(rootPath, '.assetforge', 'backups');
    for (const name of await readdir(directory)) await writeFile(join(directory, name), 'not a database');
    await value('workspace:close', {});

    const listing = await value<BackupListing>('workspace:backups', { id });
    const result = await send('workspace:restore', { rootPath, backupId: listing.backups[0]!.backupId });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed', message: BACKUP_DAMAGED_MESSAGE } });
    await value('workspace:open', { rootPath });
    expect(await projectNames()).toEqual(['Current']);
  });

  it('a restore aborted while it waits in the lifecycle queue fails and changes nothing', async () => {
    const { id, rootPath } = await createWorkspace('Own');
    await value('projects:create', { name: 'Old' });
    await value('backup:now', {});
    await value('projects:create', { name: 'New' });
    // The only backup so far holds just `Old`; a restore that went ahead would drop `New`.
    const listing = await value<BackupListing>('workspace:backups', { id });
    expect(listing.backups).toHaveLength(1);

    let release = () => undefined as void;
    closingGate = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
    const closing = send('workspace:close', {});
    const restoring = send('workspace:restore', { rootPath, backupId: listing.backups[0]!.backupId });
    await vi.waitFor(() => expect(restores.size).toBe(1));
    restores.abortAll();
    const gate = closingGate;
    closingGate = null;
    gate.release();

    await closing;
    expect(await restoring).toMatchObject({ ok: false, error: { code: 'backup_failed' } });
    await value('workspace:open', { rootPath });
    expect((await projectNames()).sort()).toEqual(['New', 'Old']);
  });

  it('a folder that cannot be reached answers what opening it answers', async () => {
    // A folder below a file can never be reached, like a share that is offline.
    await writeFile(join(base, 'offline'), '');
    const rootPath = join(base, 'offline', 'root');
    const opened = await send('workspace:open', { rootPath });
    expect(opened.ok).toBe(false);
    const restored = await send('workspace:restore', { rootPath, backupId: randomUUID() });
    expect(restored).toEqual(opened);
    expect(restored).toMatchObject({ error: { code: 'storage_unreachable' } });
  });

  it('lists the backups of another lineage in the status and deletes one of them', async () => {
    const { id, rootPath } = await createWorkspace('Own');
    await value('workspace:close', {});
    await loseDatabase(id);
    // A new, empty database starts a new lineage; the copies of the lost one are now another lineage.
    await value('workspace:open', { rootPath, startEmpty: true });
    const status = await value<BackupStatus>('backup:status', {});
    expect(status.otherLineages.length).toBeGreaterThan(0);
    const after = await value<BackupStatus>('backup:delete', { backupId: status.otherLineages[0]!.backupId });
    expect(after.otherLineages).toHaveLength(status.otherLineages.length - 1);
    // The id is gone with its listing.
    expect(await send('backup:delete', { backupId: status.otherLineages[0]!.backupId })).toMatchObject({
      ok: false,
      error: { message: BACKUP_STALE_MESSAGE },
    });
  });
});
