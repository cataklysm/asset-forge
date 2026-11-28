import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ImportProgress } from '@assetforge/contracts';
import {
  ARCHIVE_EMPTY_MESSAGE,
  ARCHIVE_TRUNCATED_MESSAGE,
  NotFoundError,
  REFUSED_IMPORT_MESSAGE,
  WorkspaceManager,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ASSET = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  /** One entry per `writeStream` call: the progress when it started, then after every reported chunk. */
  const writes: ImportProgress[][] = [];
  /** Runs before every `writeStream` with its index; may cancel. */
  let beforeWrite: (index: number) => void = () => {};
  const original = storage.writeStream.bind(storage);
  storage.writeStream = (relPath: string, source: Readable, options?: { onProgress?(bytes: number): void }) => {
    const index = writes.length;
    const seen: ImportProgress[] = [manager.importProgress()!];
    writes.push(seen);
    beforeWrite(index);
    return original(relPath, source, {
      onProgress: (bytes) => {
        options?.onProgress?.(bytes);
        seen.push(manager.importProgress()!);
      },
    });
  };
  const unpack = (sourcePaths: string[]) => manager.importFiles(sourcePaths, null, { unpackArchives: true });
  return { ...fake, manager, storage, writes, unpack, onWrite: (fn: (index: number) => void) => (beforeWrite = fn) };
}

const progress = (
  done: number,
  total: number,
  currentBytes: number,
  currentSize: number | null,
  cancelling = false,
) => ({
  done,
  total,
  currentBytes,
  currentSize,
  cancelling,
});

describe('import progress', () => {
  it('is null without a workspace, before and after an import, and cancel answers false then', async () => {
    const fake = createFakeHost();
    const manager = new WorkspaceManager(fake.host);
    expect(manager.importProgress()).toBeNull();
    expect(manager.cancelImport()).toBe(false);

    const { manager: open, sources } = await setup();
    expect(open.importProgress()).toBeNull();
    expect(open.cancelImport()).toBe(false);
    sources.set('/src/a.png', Buffer.from('a'));
    await open.importFiles(['/src/a.png']);
    expect(open.importProgress()).toBeNull();
    expect(open.cancelImport()).toBe(false);
  });

  it('counts plain sources and reports the bytes and size of the item in progress', async () => {
    const { manager, sources, writes } = await setup();
    sources.chunkSize = 2;
    sources.set('/src/a.png', Buffer.from('aaaaaa'));
    sources.set('/src/b.png', Buffer.from('bbb'));
    sources.unknownSize.add('/src/b.png');

    const results = await manager.importFiles(['/src/a.png', '/src/b.png']);

    expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
    expect(writes).toEqual([
      [progress(0, 2, 0, 6), progress(0, 2, 2, 6), progress(0, 2, 4, 6), progress(0, 2, 6, 6)],
      [progress(1, 2, 0, null), progress(1, 2, 2, null), progress(1, 2, 3, null)],
    ]);
    expect(manager.importProgress()).toBeNull();
  });

  it('reports a source of 0 bytes with size 0', async () => {
    const { manager, sources, writes } = await setup();
    sources.set('/src/empty.png', Buffer.alloc(0));
    sources.set('/src/next.png', Buffer.from('n'));

    await manager.importFiles(['/src/empty.png', '/src/next.png']);

    expect(writes[0]![0]).toEqual(progress(0, 2, 0, 0));
    expect(writes[1]![0]).toEqual(progress(1, 2, 0, 1));
  });

  it('answers a copy, never the live state', async () => {
    const { manager, sources, onWrite } = await setup();
    sources.set('/src/a.png', Buffer.from('a'));
    let copy: ImportProgress | null = null;
    onWrite(() => {
      copy = manager.importProgress();
      copy!.done = 99;
      copy!.cancelling = true;
    });
    await manager.importFiles(['/src/a.png', '/src/a.png']);
    expect(copy).not.toBeNull();
    // The mutated copy neither counted nor cancelled: both sources were imported.
    expect(sources.opened).toEqual(['/src/a.png', '/src/a.png']);
  });

  it('grows the total by the entries of an unpacked archive that give a result', async () => {
    const { unpack, sources, archives, writes } = await setup();
    sources.set('/src/one.png', Buffer.from('1'));
    sources.set('/src/two.png', Buffer.from('22'));
    archives.set('/src/pack.zip', [
      { name: 'dir/', isDirectory: true },
      { name: '__MACOSX/._a.png', content: 'junk' },
      { name: 'a.png', content: 'aaa', declaredSize: 3 },
      { name: 'evil.exe', content: 'x' },
      { name: 'dir/b.png', content: 'bbbb' },
    ]);

    const results = await unpack(['/src/one.png', '/src/pack.zip', '/src/two.png']);

    expect(results.map((r) => [r.entryName, r.error])).toEqual([
      [null, null],
      ['a.png', null],
      ['evil.exe', REFUSED_IMPORT_MESSAGE],
      ['dir/b.png', null],
      [null, null],
    ]);
    expect(writes.map((w) => w[0])).toEqual([
      progress(0, 3, 0, 1),
      progress(1, 5, 0, 3),
      progress(3, 5, 0, 4),
      progress(4, 5, 0, 2),
    ]);
    expect(writes[1]!.at(-1)).toEqual(progress(1, 5, 3, 3));
  });

  it('keeps a failed and an empty archive as one item each', async () => {
    const { unpack, sources, archives, writes } = await setup();
    archives.set('/src/bad.zip', 'not-zip');
    archives.set('/src/empty.zip', [{ name: 'd/', isDirectory: true }]);
    sources.set('/src/after.png', Buffer.from('a'));

    const results = await unpack(['/src/bad.zip', '/src/empty.zip', '/src/after.png']);

    expect(results.map((r) => r.error)).toEqual([
      'This file is not a readable ZIP archive',
      ARCHIVE_EMPTY_MESSAGE,
      null,
    ]);
    expect(writes.map((w) => w[0])).toEqual([progress(2, 3, 0, 1)]);
  });

  it('stops after the source in progress when cancelled between two sources', async () => {
    const { manager, sources, writes, onWrite } = await setup();
    sources.set('/src/a.png', Buffer.from('a'));
    sources.set('/src/b.png', Buffer.from('b'));
    const answers: boolean[] = [];
    onWrite(() => {
      answers.push(manager.cancelImport(), manager.cancelImport());
    });

    const results = await manager.importFiles(['/src/a.png', '/src/b.png']);

    expect(answers).toEqual([true, true]);
    expect(writes[0]!.at(-1)).toEqual(progress(0, 2, 1, 1, true));
    expect(results.map((r) => [r.sourcePath, r.file?.status])).toEqual([['/src/a.png', 'complete']]);
    expect(sources.opened).toEqual(['/src/a.png']);
    expect(manager.importProgress()).toBeNull();

    // The mark ends with the import: the next one imports everything.
    onWrite(() => {});
    expect(await manager.importFiles(['/src/a.png', '/src/b.png'])).toHaveLength(2);
  });

  it('stops after the entry in progress when cancelled between two entries, and starts no further source', async () => {
    const { manager, unpack, sources, archives, onWrite } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'a.png', content: 'a' },
      { name: 'b.png', content: 'b' },
      { name: 'c.png', content: 'c' },
    ]);
    sources.set('/src/after.png', Buffer.from('x'));
    onWrite(() => manager.cancelImport());

    const results = await unpack(['/src/pack.zip', '/src/after.png']);

    expect(results.map((r) => [r.entryName, r.file?.status])).toEqual([['a.png', 'complete']]);
    expect(archives.openedEntries).toEqual([0]);
    expect(archives.closed).toBe(1);
    expect(sources.opened).toEqual([]);
  });

  it('answers no result for an archive cancelled before its first entry', async () => {
    const { manager, unpack, archives } = await setup();
    archives.set('/src/pack.zip', [{ name: 'a.png', content: 'a' }]);
    const open = archives.open.bind(archives);
    archives.open = async (path, limits) => {
      const archive = await open(path, limits);
      manager.cancelImport();
      return archive;
    };

    expect(await unpack(['/src/pack.zip'])).toEqual([]);
    expect(archives.openedEntries).toEqual([]);
    expect(archives.closed).toBe(1);
  });

  it('ends normally with every result when cancelled during the last item', async () => {
    const { manager, sources, onWrite } = await setup();
    sources.set('/src/a.png', Buffer.from('a'));
    sources.set('/src/b.png', Buffer.from('b'));
    onWrite((index) => {
      if (index === 1) manager.cancelImport();
    });

    const results = await manager.importFiles(['/src/a.png', '/src/b.png']);

    expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
    expect(manager.importProgress()).toBeNull();
  });

  it('is null after an import that throws before the first item, and the next one starts clean', async () => {
    const { manager, sources, writes } = await setup();
    sources.set('/src/a.png', Buffer.from('a'));

    await expect(
      manager.importFiles(['/src/a.png'], { assetId: UNKNOWN_ASSET, role: 'reference' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(manager.importProgress()).toBeNull();
    expect(manager.cancelImport()).toBe(false);

    const results = await manager.importFiles(['/src/a.png', '/src/a.png']);
    expect(results).toHaveLength(2);
    expect(writes.map((w) => w[0])).toEqual([progress(0, 2, 0, 1), progress(1, 2, 0, 1)]);
  });
});

/** The manager's live progress object, captured while the import runs and inspected after it settled. */
function captureLive(
  manager: WorkspaceManager,
  onWrite: (fn: (index: number) => void) => void,
): () => ImportProgress | null {
  let live: ImportProgress | null = null;
  onWrite(() => {
    live ??= (manager as unknown as { importProgress_: ImportProgress | null }).importProgress_;
  });
  return () => live;
}

describe('import progress when an item is done', () => {
  it('resets the current item in the step that counts a plain source', async () => {
    const { manager, sources, onWrite } = await setup();
    sources.set('/src/a.png', Buffer.from('aaaa'));
    const live = captureLive(manager, onWrite);

    await manager.importFiles(['/src/a.png']);

    expect(live()).toEqual(progress(1, 1, 0, null));
  });

  it('resets the current item in the step that counts an archive entry', async () => {
    const { manager, unpack, archives, onWrite } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'a.png', content: 'aaa' },
      { name: 'b.png', content: 'bb' },
    ]);
    const live = captureLive(manager, onWrite);
    const atClose: (ImportProgress | null)[] = [];
    const open = archives.open.bind(archives);
    archives.open = async (path, limits) => {
      const archive = await open(path, limits);
      const close = archive.close;
      return { ...archive, close: async () => (atClose.push(manager.importProgress()), close()) };
    };

    await unpack(['/src/pack.zip']);

    expect(atClose).toEqual([progress(2, 2, 0, null)]);
    expect(live()).toEqual(progress(2, 2, 0, null));
  });

  it('counts a refused and an unreadable plain source', async () => {
    const { manager, sources, onWrite } = await setup();
    sources.set('/src/ok.png', Buffer.from('ok'));
    sources.set('/src/gone.png', Buffer.from('x'));
    sources.unreadable.add('/src/gone.png');
    const live = captureLive(manager, onWrite);

    const results = await manager.importFiles(['/src/ok.png', '/src/tool.exe', '/src/gone.png']);

    expect(results.map((r) => [r.sourcePath, r.error])).toEqual([
      ['/src/ok.png', null],
      ['/src/tool.exe', REFUSED_IMPORT_MESSAGE],
      ['/src/gone.png', 'This file cannot be read'],
    ]);
    expect(live()).toEqual(progress(3, 3, 0, null));
  });

  it('counts an archive entry that cannot be opened and still tries the following ones', async () => {
    const { manager, unpack, archives, onWrite } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'a.png', content: 'a' },
      { name: 'broken.png', content: 'b', failOpen: true },
      { name: 'c.png', content: 'c' },
    ]);
    const live = captureLive(manager, onWrite);

    const results = await unpack(['/src/pack.zip']);

    expect(results.map((r) => [r.entryName, r.error])).toEqual([
      ['a.png', null],
      ['broken.png', ARCHIVE_TRUNCATED_MESSAGE],
      ['c.png', null],
    ]);
    expect(archives.openedEntries).toEqual([0, 1, 2]);
    expect(live()).toEqual(progress(3, 3, 0, null));
  });
});
