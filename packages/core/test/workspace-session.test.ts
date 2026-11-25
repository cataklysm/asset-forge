import { describe, expect, it, vi } from 'vitest';
import { NoWorkspaceOpenError, WorkspaceManager, type WorkspaceSession } from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';

function setup() {
  const fake = createFakeHost();
  return { ...fake, manager: new WorkspaceManager(fake.host) };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets every already-scheduled promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('WorkspaceManager sessions', () => {
  it("read hands out the open workspace's session", async () => {
    const { manager, databases, storages } = setup();
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const db = databases.get(summary.id)!;

    const session = await manager.read(async (s) => s);
    expect(session.summary.id).toBe(summary.id);
    expect(session.storageId).toBe((await db.storages.getPrimary())!.id);
    expect(session.database).toBe(db);
    expect(session.storage).toBe(storages.get(ROOT));
    expect(session.newId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.now()).toBeInstanceOf(Date);

    await expect(manager.exclusive(async (s) => s.summary.id)).resolves.toBe(summary.id);
  });

  it('read and exclusive reject with no_workspace_open when nothing is open', async () => {
    const { manager } = setup();
    const fn = vi.fn(async (_s: WorkspaceSession) => 'ran');

    let read!: Promise<string>;
    let exclusive!: Promise<string>;
    expect(() => {
      read = manager.read(fn);
      exclusive = manager.exclusive(fn);
    }).not.toThrow();

    await expect(read).rejects.toBeInstanceOf(NoWorkspaceOpenError);
    await expect(read).rejects.toMatchObject({ code: 'no_workspace_open' });
    await expect(exclusive).rejects.toMatchObject({ code: 'no_workspace_open' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('close waits for a running exclusive operation', async () => {
    const { manager, databases } = setup();
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const db = databases.get(summary.id)!;
    const gate = deferred();

    const running = manager.exclusive(async () => {
      await gate.promise;
      return db.closed;
    });
    await flush();
    const closing = manager.close();
    await flush();
    expect(db.closed).toBe(false);

    gate.resolve();
    await expect(running).resolves.toBe(false);
    await closing;
    expect(db.closed).toBe(true);
  });

  it('an exclusive operation queued behind close rejects with no_workspace_open', async () => {
    const { manager } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    const fn = vi.fn(async (_s: WorkspaceSession) => 'ran');

    const closing = manager.close();
    const queued = manager.exclusive(fn);

    await closing;
    await expect(queued).rejects.toMatchObject({ code: 'no_workspace_open' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('create still opens the workspace', async () => {
    const { manager } = setup();
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    expect(manager.current()).toEqual(summary);

    // Opening over an open workspace closes it first, through the same queue.
    await manager.close();
    await expect(manager.open({ rootPath: ROOT })).resolves.toMatchObject({ id: summary.id });
    await expect(manager.open({ rootPath: ROOT })).resolves.toMatchObject({ id: summary.id });
  });

  it('importFiles and close do not interleave', async () => {
    const { manager, databases, sources } = setup();
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const db = databases.get(summary.id)!;
    sources.set('/src/a.png', Buffer.from('a'));
    sources.set('/src/b.png', Buffer.from('b'));

    const gate = deferred();
    const openSource = sources.open.bind(sources);
    sources.open = async (absolutePath) => {
      await gate.promise;
      return openSource(absolutePath);
    };
    const closedWhenCompleted: boolean[] = [];
    const markComplete = db.files.markComplete.bind(db.files);
    db.files.markComplete = async (id, r) => {
      closedWhenCompleted.push(db.closed);
      return markComplete(id, r);
    };

    const importing = manager.importFiles(['/src/a.png', '/src/b.png']);
    await flush();
    const closing = manager.close();
    await flush();
    expect(db.closed).toBe(false);

    gate.resolve();
    const results = await importing;
    await closing;

    expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
    expect(closedWhenCompleted).toEqual([false, false]);
    expect(db.closed).toBe(true);
    expect(manager.current()).toBeNull();
  });
});
