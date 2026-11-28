import { describe, expect, it } from 'vitest';
import { BACKUP_INTERVAL_MS, BACKUP_MESSAGES, BACKUP_QUIT_DEADLINE_MS } from '@assetforge/contracts';
import { BackupError, NoWorkspaceOpenError, WorkspaceManager, backupFileName } from '../src/index.js';
import type { BackupTimers } from '../src/ports/workspace-backups.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const OTHER_ROOT = '/ws/b';
const NOW = new Date('2026-11-28T10:00:00.000Z');
const DIRECTORY = `${ROOT}/assetforge-backups`;

/** Timers that only fire when the test says so. */
class FakeTimers implements BackupTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  set(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { callback, ms });
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires every pending timer of this delay. */
  fire(ms: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(handle);
      timer.callback();
    }
  }

  /** The callbacks of the pending timers of this delay. */
  callbacks(ms: number): (() => void)[] {
    return [...this.pending.values()].filter((timer) => timer.ms === ms).map((timer) => timer.callback);
  }
}

/** Lets every pending promise chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A promise the test resolves. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function setup() {
  const fake = createFakeHost();
  const timers = new FakeTimers();
  const lines: string[] = [];
  fake.host.timers = timers;
  fake.host.now = () => NOW;
  fake.host.log = (line) => lines.push(line);
  const manager = new WorkspaceManager(fake.host);
  const writes = () => fake.backups.calls.filter((call) => call.method === 'write').map((call) => call.args[2]);
  return { ...fake, timers, lines, manager, writes };
}

/** A workspace that was closed once (writing its first backup) and opened again, so only changes count. */
async function reopened() {
  const context = setup();
  const summary = await context.manager.create({ name: 'Demo', rootPath: ROOT });
  await context.manager.close();
  await context.manager.open({ rootPath: ROOT });
  await settle();
  const database = context.databases.get(summary.id)!;
  const lineageId = database.meta.current!.lineageId;
  context.backups.calls.length = 0;
  return { ...context, summary, database, lineageId };
}

describe('workspace backup service', () => {
  it('close after a change writes one backup named with lineage, UTC stamp and m<count>', async () => {
    const { manager, database, lineageId, writes } = await reopened();
    database.changes++;
    await manager.close();
    expect(writes()).toEqual([backupFileName(lineageId, NOW, 0)]);
    expect(writes()[0]).toBe(`assetforge-${lineageId.slice(0, 12)}-20261128T100000Z-m0.sqlite`);
  });

  it('close after only reads writes none', async () => {
    const { manager, writes } = await reopened();
    await manager.close();
    expect(writes()).toEqual([]);
  });

  it('hourly timer writes only when changed and re-arms', async () => {
    const { manager, database, timers, writes } = await reopened();
    timers.fire(BACKUP_INTERVAL_MS);
    await settle();
    expect(writes()).toEqual([]);
    expect(timers.callbacks(BACKUP_INTERVAL_MS)).toHaveLength(1);

    database.changes++;
    timers.fire(BACKUP_INTERVAL_MS);
    await settle();
    expect(writes()).toHaveLength(1);
    expect(timers.callbacks(BACKUP_INTERVAL_MS)).toHaveLength(1);
    expect(manager.backupState().last).toMatchObject({ ok: true, code: null });

    timers.fire(BACKUP_INTERVAL_MS);
    await settle();
    expect(writes()).toHaveLength(1);
  });

  it('timer firing after close or switch touches nothing', async () => {
    const { manager, database, timers, backups, databases } = await reopened();
    const [beforeClose] = timers.callbacks(BACKUP_INTERVAL_MS);
    await manager.close();
    expect(timers.callbacks(BACKUP_INTERVAL_MS)).toEqual([]);
    database.changes++;
    backups.calls.length = 0;
    beforeClose!();
    await settle();
    expect(backups.calls).toEqual([]);

    await manager.open({ rootPath: ROOT });
    await settle();
    const [beforeSwitch] = timers.callbacks(BACKUP_INTERVAL_MS);
    const other = await manager.create({ name: 'Other', rootPath: OTHER_ROOT });
    await settle();
    const snapshotsBefore = database.snapshotCalls;
    database.changes++;
    beforeSwitch!();
    await settle();
    expect(database.snapshotCalls).toBe(snapshotsBefore);
    expect(databases.get(other.id)!.snapshotCalls).toBe(0);
  });

  it('a close during a running backup waits for it and then writes the closing one only if changed since', async () => {
    const first = await reopened();
    let hold = gate();
    first.backups.writeDelay = hold.promise;
    const running = first.manager.backupNow();
    await settle();
    let closed = false;
    const closing = first.manager.close().then(() => (closed = true));
    await settle();
    expect(closed).toBe(false);
    hold.open();
    await closing;
    await running;
    expect(first.writes()).toHaveLength(1);

    const second = await reopened();
    hold = gate();
    second.backups.writeDelay = hold.promise;
    const busy = second.manager.backupNow();
    await settle();
    second.database.changes++;
    const closingAgain = second.manager.close();
    await settle();
    second.backups.writeDelay = null;
    hold.open();
    await closingAgain;
    await busy;
    expect(second.writes()).toHaveLength(2);
  });

  it('backupNow while one runs joins it, then runs its own', async () => {
    const { manager, backups, writes } = await reopened();
    const hold = gate();
    backups.writeDelay = hold.promise;
    const first = manager.backupNow();
    await settle();
    expect(manager.backupState().running).toBe(true);
    const second = manager.backupNow();
    await settle();
    expect(writes()).toHaveLength(1);
    hold.open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(writes()).toHaveLength(2);
    expect(manager.backupState().running).toBe(false);
  });

  it('deadline aborts the snapshot or write, discard is called, close resolves', async () => {
    const { manager, database, backups, timers, summary } = await reopened();
    database.changes++;
    const hold = gate();
    backups.writeDelay = hold.promise;
    const discardedBefore = backups.discarded;
    const closing = manager.close();
    await settle();
    timers.fire(BACKUP_QUIT_DEADLINE_MS);
    await closing;
    expect(database.closed).toBe(true);
    hold.open();
    await settle();
    expect(backups.discarded).toBe(discardedBefore + 1);

    await manager.open({ rootPath: ROOT });
    expect(manager.backupState()).toMatchObject({
      workspaceId: summary.id,
      last: { ok: false, code: 'backup_failed', message: BACKUP_MESSAGES.backup_failed },
    });
  });

  it('a failing write never fails close; lastAttempt carries code and fixed message; one log line with workspace and code but no path', async () => {
    const { manager, database, backups, lines, summary } = await reopened();
    database.changes++;
    backups.failures.set('write', new BackupError('backup_no_space'));
    await expect(manager.close()).resolves.toBeUndefined();
    const failures = lines.filter((line) => line.startsWith('Backup failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`workspace=${summary.id}`);
    expect(failures[0]).toContain('code=backup_no_space');
    expect(failures[0]).not.toContain('/ws');

    backups.failures.clear();
    await manager.open({ rootPath: ROOT });
    expect(manager.backupState().last).toEqual({
      at: NOW.toISOString(),
      ok: false,
      code: 'backup_no_space',
      message: BACKUP_MESSAGES.backup_no_space,
    });
  });

  it('non-BackupError becomes backup_failed', async () => {
    const { manager, database, lines } = await reopened();
    database.snapshotFailure = new Error(`EIO: i/o error, open '${ROOT}/secret.sqlite'`);
    const attempt = await manager.backupNow();
    expect(attempt).toMatchObject({ ok: false, code: 'backup_failed', message: BACKUP_MESSAGES.backup_failed });
    expect(lines.join('\n')).not.toContain('secret');
    expect(lines.join('\n')).not.toContain('/ws');
  });

  it('first open with no same-lineage backup counts as changed', async () => {
    const plain = setup();
    await plain.manager.create({ name: 'Demo', rootPath: ROOT });
    await plain.manager.close();
    expect(plain.writes()).toHaveLength(1);

    const foreign = setup();
    foreign.backups.addFile(DIRECTORY, backupFileName('fedcba9876543210fedcba9876543210', NOW, 3));
    await foreign.manager.create({ name: 'Demo', rootPath: ROOT });
    await foreign.manager.close();
    expect(foreign.writes()).toHaveLength(1);

    const offline = setup();
    offline.backups.unreachable.add(DIRECTORY);
    await offline.manager.create({ name: 'Demo', rootPath: ROOT });
    await offline.manager.close();
    expect(offline.writes()).toEqual([]);
  });

  it('backupNow without an open workspace is refused', async () => {
    const { manager } = setup();
    await expect(manager.backupNow()).rejects.toBeInstanceOf(NoWorkspaceOpenError);
    expect(manager.backupState()).toEqual({ workspaceId: null, running: false, last: null });
  });
});
