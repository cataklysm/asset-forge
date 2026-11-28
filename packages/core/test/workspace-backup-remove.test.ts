import { describe, expect, it } from 'vitest';
import { BACKUP_MESSAGES, BACKUP_NOT_DELETABLE_MESSAGE, BACKUP_QUIT_DEADLINE_MS } from '@assetforge/contracts';
import { BackupError, InvalidOperationError, NoWorkspaceOpenError, WorkspaceManager } from '../src/index.js';
import { backupFileName } from '../src/backup-names.js';
import type { BackupSource, BackupTimers } from '../src/ports/workspace-backups.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const NOW = new Date('2026-11-28T10:00:00.000Z');
const DIRECTORY = `${ROOT}/assetforge-backups`;
const OTHER_LINEAGE = 'fedcba9876543210fedcba9876543210';

/** Timers that only fire when a test says so. */
class FakeTimers implements BackupTimers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;

  set(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { callback, ms });
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /**
   * Fires every pending timer of a duration.
   *
   * @param ms the duration
   */
  fire(ms: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(handle);
      timer.callback();
    }
  }
}

/** Lets pending promise chains run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const fake = createFakeHost();
  const timers = new FakeTimers();
  const lines: string[] = [];
  const order: string[] = [];
  fake.host.timers = timers;
  fake.host.now = () => NOW;
  fake.host.log = (line) => lines.push(line);
  const moveToTrash = fake.host.moveToTrash.bind(fake.host);
  fake.host.moveToTrash = async (rootPath) => {
    order.push('moveToTrash');
    await moveToTrash(rootPath);
  };
  const write = fake.backups.write.bind(fake.backups);
  fake.backups.write = async (...args) => {
    order.push('write');
    await write(...args);
  };
  const writes = () => fake.backups.calls.filter((call) => call.method === 'write');
  return { ...fake, timers, lines, order, writes, manager: new WorkspaceManager(fake.host) };
}

describe('the final backup before a remove', () => {
  it('is written before the folder goes to the trash', async () => {
    const { manager, order, writes, backups } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    order.length = 0;
    const before = writes().length;

    await manager.remove({ id, trashFolder: true });
    expect(order).toEqual(['write', 'moveToTrash']);
    expect(writes()).toHaveLength(before + 1);
    expect(backups.calls.some((call) => call.method === 'snapshotClosed')).toBe(true);
  });

  it('a failed final backup refuses the remove with its code and leaves everything untouched', async () => {
    const { manager, host, backups, databases, trash, lines } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    backups.failures.set('write', new BackupError('backup_location_unreachable'));

    await expect(manager.remove({ id, trashFolder: true })).rejects.toMatchObject({
      code: 'backup_location_unreachable',
      message: BACKUP_MESSAGES.backup_location_unreachable,
    });
    expect(await host.registry.list()).toHaveLength(1);
    expect(databases.has(id)).toBe(true);
    expect(trash.paths).toEqual([]);
    expect(lines.some((line) => line.includes('Backup failed') && !line.includes(ROOT))).toBe(true);
  });

  it('skipFinalBackup removes without a backup', async () => {
    const { manager, host, backups, writes } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    backups.failures.set('write', new BackupError('backup_failed'));
    const before = writes().length;

    await manager.remove({ id, trashFolder: false, skipFinalBackup: true });
    expect(writes()).toHaveLength(before);
    expect(backups.calls.some((call) => call.method === 'snapshotClosed')).toBe(false);
    expect(await host.registry.list()).toEqual([]);
  });

  it('a workspace without its database is removed without a backup', async () => {
    const { manager, host, backups, missingDatabases } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    missingDatabases.add(id);
    backups.failures.set('snapshotClosed', new BackupError('backup_failed'));

    await manager.remove({ id, trashFolder: false });
    expect(backups.calls.some((call) => call.method === 'snapshotClosed')).toBe(false);
    expect(await host.registry.list()).toEqual([]);
  });

  it('removing the open workspace writes no closing backup and exactly one final backup', async () => {
    const { manager, backups, databases, writes } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await settle();
    databases.get(id)!.changes++;
    const before = writes().length;

    await manager.remove({ id, trashFolder: false });
    expect(writes()).toHaveLength(before + 1);
    expect(databases.get(id)?.snapshotCalls ?? 0).toBe(0);
    expect(backups.calls.filter((call) => call.method === 'snapshotClosed')).toHaveLength(1);
    expect(manager.current()).toBeNull();
  });

  it('a final backup cut off by the deadline refuses the remove', async () => {
    const { manager, host, backups, databases, timers } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    backups.writeDelay = new Promise(() => undefined);

    const removal = manager.remove({ id, trashFolder: false });
    const outcome = removal.catch((error: unknown) => error);
    await settle();
    timers.fire(BACKUP_QUIT_DEADLINE_MS);
    expect(await outcome).toMatchObject({ code: 'backup_failed' });
    expect(await host.registry.list()).toHaveLength(1);
    expect(databases.has(id)).toBe(true);
  });
});

describe('backupStatus', () => {
  it('counts only the backups of the live lineage and lists the others', async () => {
    const { manager, backups, databases } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    const lineageId = databases.get(id)!.meta.current!.lineageId;
    backups.addFile(DIRECTORY, backupFileName(lineageId, NOW, 0), 100);
    backups.addFile(DIRECTORY, backupFileName(lineageId, new Date('2026-11-27T10:00:00.000Z'), 0), 50);
    const other = backupFileName(OTHER_LINEAGE, new Date('2026-11-26T10:00:00.000Z'), 2);
    backups.addFile(DIRECTORY, other, 70);
    backups.addFile(DIRECTORY, 'notes.txt', 999);

    const status = await manager.backupStatus();
    expect(status).toMatchObject({ reachable: true, running: false, last: null, count: 2, totalBytes: 150 });
    expect(status.location.directory).toBe(DIRECTORY);
    expect(status.otherLineages.map((backup) => backup.source.name)).toEqual([other]);
  });

  it('an unreachable place answers reachable false and no backups', async () => {
    const { manager, backups } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    backups.unreachable.add(DIRECTORY);
    await expect(manager.backupStatus()).resolves.toMatchObject({
      reachable: false,
      count: 0,
      totalBytes: 0,
      otherLineages: [],
    });
  });

  it('the last attempt and the running flag come from the service', async () => {
    const { manager } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    const attempt = await manager.backupNow();
    await expect(manager.backupStatus()).resolves.toMatchObject({ running: false, last: attempt, count: 1 });
  });

  it('needs an open workspace', async () => {
    const { manager } = setup();
    await expect(manager.backupStatus()).rejects.toBeInstanceOf(NoWorkspaceOpenError);
  });
});

describe('deleteBackup', () => {
  function regular(name: string, directory = DIRECTORY): BackupSource {
    return { origin: 'regular', directory, name };
  }

  it('deletes a backup of another lineage in the place', async () => {
    const { manager, backups } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    const other = backupFileName(OTHER_LINEAGE, NOW, 1);
    backups.addFile(DIRECTORY, other);

    await manager.deleteBackup(regular(other));
    expect(backups.directories.get(DIRECTORY)!.has(other)).toBe(false);
  });

  it('refuses a backup of the live lineage, a pre-migration copy, another folder and an unknown name', async () => {
    const { manager, backups, databases } = setup();
    const { id } = await manager.create({ name: 'Demo', rootPath: ROOT });
    const own = backupFileName(databases.get(id)!.meta.current!.lineageId, NOW, 0);
    const other = backupFileName(OTHER_LINEAGE, NOW, 1);
    backups.addFile(DIRECTORY, own);
    const refused: BackupSource[] = [
      regular(own),
      { origin: 'pre_migration', directory: null, name: other },
      regular(other, '/elsewhere'),
      regular('notes.txt'),
    ];
    for (const source of refused) {
      const error = await manager.deleteBackup(source).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidOperationError);
      expect((error as Error).message).toBe(BACKUP_NOT_DELETABLE_MESSAGE);
    }
    expect(backups.calls.some((call) => call.method === 'remove')).toBe(false);
    expect(backups.directories.get(DIRECTORY)!.has(own)).toBe(true);
  });

  it('needs an open workspace', async () => {
    const { manager } = setup();
    await expect(manager.deleteBackup(regular(backupFileName(OTHER_LINEAGE, NOW, 1)))).rejects.toBeInstanceOf(
      NoWorkspaceOpenError,
    );
  });
});
