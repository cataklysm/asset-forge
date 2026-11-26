import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_EMPTY_MESSAGE,
  ARCHIVE_ENTRY_REFUSED_MESSAGE,
  ARCHIVE_TRUNCATED_MESSAGE,
  ArchiveNotReadableError,
  ArchiveTooLargeError,
  assetFilePath,
  createAsset,
  inboxPath,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  REFUSED_IMPORT_MESSAGE,
  STAGING_DIR,
  WorkspaceManager,
} from '../src/index.js';
import type { FileTarget } from '@assetforge/contracts';
import { createFakeHost, type FakeArchiveEntry, type InMemoryStorage } from './fakes.js';

const ROOT = '/ws/a';
const TOO_LARGE = 'This archive is too large to unpack';
const NOT_A_ZIP = 'This file is not a readable ZIP archive';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const unpack = (sourcePaths: string[], target: FileTarget | null = null) =>
    manager.importFiles(sourcePaths, target, { unpackArchives: true });
  return { ...fake, manager, storage, db, unpack };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Every binary an import wrote: inbox, asset directories and staging. */
const written = (storage: InMemoryStorage) =>
  [...storage.files.keys()].filter((k) => k.startsWith('inbox/') || k.startsWith('assets/') || k.startsWith(`${STAGING_DIR}/`));
const stagingEntries = (storage: InMemoryStorage) => [...storage.files.keys()].filter((k) => k.startsWith(`${STAGING_DIR}/`));
const dirs = (count: number): FakeArchiveEntry[] => Array.from({ length: count }, (_, i) => ({ name: `d${i}/`, isDirectory: true }));
const failure = (sourcePath: string, error: string) => ({ sourcePath, entryName: null, file: null, error, duplicateOf: [] });

describe('importFiles without unpacking', () => {
  it('imports a .zip as one file when unpackArchives is omitted or false', async () => {
    const { manager, sources, archives, storage } = await setup();
    sources.set('/src/pack.zip', Buffer.from('PK-bytes'));
    archives.set('/src/pack.zip', [{ name: 'a.png', content: 'a' }]);

    for (const results of [await manager.importFiles(['/src/pack.zip']), await manager.importFiles(['/src/pack.zip'], null, { unpackArchives: false })]) {
      expect(results).toHaveLength(1);
      const [result] = results;
      expect(result).toMatchObject({ sourcePath: '/src/pack.zip', entryName: null, error: null });
      expect(result!.file).toMatchObject({ status: 'complete', originalName: 'pack.zip', sha256: sha('PK-bytes'), sizeBytes: 8, kind: 'other' });
      expect(storage.files.get(result!.file!.relativePath)?.toString()).toBe('PK-bytes');
    }
    expect(archives.opened).toEqual([]);
  });
});

describe('importFiles unpacking archives', () => {
  it('imports each entry as a complete file in directory order', async () => {
    const { unpack, archives, storage, db } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'b.png', content: 'bee' },
      { name: 'notes.txt', content: 'alpha!' },
    ]);

    const results = await unpack(['/src/pack.zip']);

    expect(results.map((r) => [r.sourcePath, r.entryName, r.error, r.duplicateOf])).toEqual([
      ['/src/pack.zip', 'b.png', null, []],
      ['/src/pack.zip', 'notes.txt', null, []],
    ]);
    expect(results.map((r) => r.file)).toMatchObject([
      { status: 'complete', originalName: 'b.png', sha256: sha('bee'), sizeBytes: 3, kind: 'image', assetId: null },
      { status: 'complete', originalName: 'notes.txt', sha256: sha('alpha!'), sizeBytes: 6, kind: 'document', assetId: null },
    ]);
    for (const { file } of results) {
      expect(db.files.records.get(file!.id)).toMatchObject({ status: 'complete', sha256: file!.sha256 });
    }
    expect(results.map((r) => storage.files.get(r.file!.relativePath)?.toString())).toEqual(['bee', 'alpha!']);
    expect(stagingEntries(storage)).toEqual([]);
    expect(archives.closed).toBe(1);
  });

  it('keeps the order of sourcePaths across plain files and archives', async () => {
    const { unpack, archives, sources } = await setup();
    sources.set('/src/one.png', Buffer.from('one'));
    sources.set('/src/two.png', Buffer.from('two'));
    archives.set('/src/pack.zip', [
      { name: 'x.png', content: 'x' },
      { name: 'y.png', content: 'y' },
    ]);
    archives.set('C:\\in\\more.ZIP', [{ name: 'z.png', content: 'z' }]);

    const results = await unpack(['/src/one.png', '/src/pack.zip', '/src/two.png', 'C:\\in\\more.ZIP']);

    expect(results.map((r) => [r.sourcePath, r.entryName, r.file?.originalName])).toEqual([
      ['/src/one.png', null, 'one.png'],
      ['/src/pack.zip', 'x.png', 'x.png'],
      ['/src/pack.zip', 'y.png', 'y.png'],
      ['/src/two.png', null, 'two.png'],
      ['C:\\in\\more.ZIP', 'z.png', 'z.png'],
    ]);
    expect(results.every((r) => r.file?.status === 'complete')).toBe(true);
  });

  it('places every entry in the target asset with the role', async () => {
    const { manager, unpack, archives, db, storage } = await setup();
    const session = await manager.read(async (s) => s);
    const typeId = (await db.assetTypes.list())[0]!.id;
    const asset = await createAsset(session, { name: 'Crate', typeId });
    archives.set('/src/pack.zip', [
      { name: 'wood.png', content: 'wood' },
      { name: 'metal.png', content: 'metal' },
    ]);

    const results = await unpack(['/src/pack.zip'], { assetId: asset.id, role: 'texture' });

    expect(results).toHaveLength(2);
    for (const { file, error } of results) {
      expect(error).toBeNull();
      expect(file).toMatchObject({ assetId: asset.id, role: 'texture', relativePath: assetFilePath(asset.id, 'texture', file!.id, file!.originalName) });
      expect(db.files.records.get(file!.id)).toMatchObject({ assetId: asset.id, role: 'texture' });
    }
    expect(written(storage).filter((k) => k.startsWith('inbox/'))).toEqual([]);
  });

  it('imports entries in folders flat under their last path segment, the same name twice as two files', async () => {
    const { unpack, archives, db } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'tex/wood/a.png', content: 'one' },
      { name: 'other\\a.png', content: 'two' },
    ]);

    const results = await unpack(['/src/pack.zip']);

    expect(results.map((r) => [r.entryName, r.file?.originalName, r.file?.status])).toEqual([
      ['tex/wood/a.png', 'a.png', 'complete'],
      ['other\\a.png', 'a.png', 'complete'],
    ]);
    expect(results[0]!.file!.id).not.toBe(results[1]!.file!.id);
    expect(db.files.records.size).toBe(2);
  });

  it('entry paths never influence the storage path', async () => {
    const { unpack, archives } = await setup();
    const names = ['../../evil.png', '/abs/root.png', 'C:\\Windows\\x.png', 'C:x.png', 'a\\..\\b.png', 'dir/..', '..\\..\\up.txt', '\\\\server\\share\\s.png'];
    archives.set('/src/pack.zip', names.map((name, i) => ({ name, content: `c${i}` })));

    const results = await unpack(['/src/pack.zip']);

    expect(results.map((r) => r.entryName)).toEqual(names);
    for (const { file } of results) {
      expect(file!.status).toBe('complete');
      expect(file!.relativePath).toBe(inboxPath(file!.id, file!.originalName));
      expect(file!.relativePath.split('/')).not.toContain('..');
      expect(file!.relativePath).not.toMatch(/[:\\]/);
      expect(file!.relativePath.startsWith(`inbox/${file!.id}_`)).toBe(true);
    }
  });

  it('skips directories and __MACOSX entries and refuses what cannot be imported, writing nothing for them', async () => {
    const { unpack, archives, storage, db } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'tex/', isDirectory: true },
      { name: '__MACOSX/x.png', content: 'fork' },
      { name: '__MACOSX\\tex\\._y.png', content: 'fork' },
      { name: 'tool.exe', content: 'MZ' },
      { name: 'inner.zip', content: 'PK' },
      { name: 'link.png', content: '/etc/passwd', isSymlink: true },
      { name: 'secret.png', content: 'x', isUnsupported: true },
      { name: 'folder/', content: '' },
      { name: 'bad\u0001.png', content: 'x' },
      { name: 'bad\u007f.png', content: 'x' },
      { name: 'ok.png', content: 'ok' },
    ]);

    const results = await unpack(['/src/pack.zip']);

    const refused = (entryName: string, error: string) => ({ sourcePath: '/src/pack.zip', entryName, file: null, error, duplicateOf: [] });
    expect(results.slice(0, -1)).toEqual([
      refused('tool.exe', REFUSED_IMPORT_MESSAGE),
      refused('inner.zip', REFUSED_IMPORT_MESSAGE),
      refused('link.png', ARCHIVE_ENTRY_REFUSED_MESSAGE),
      refused('secret.png', ARCHIVE_ENTRY_REFUSED_MESSAGE),
      refused('folder/', ARCHIVE_ENTRY_REFUSED_MESSAGE),
      refused('bad\u0001.png', ARCHIVE_ENTRY_REFUSED_MESSAGE),
      refused('bad\u007f.png', ARCHIVE_ENTRY_REFUSED_MESSAGE),
    ]);
    expect(results.at(-1)).toMatchObject({ entryName: 'ok.png', error: null, file: { status: 'complete', originalName: 'ok.png' } });
    expect(archives.openedEntries).toEqual([10]);
    expect([...db.files.records.values()].map((r) => r.originalName)).toEqual(['ok.png']);
    expect(written(storage)).toEqual([results.at(-1)!.file!.relativePath]);
  });

  it('an archive of only refused entries answers one refusal each', async () => {
    const { unpack, archives } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'a.exe', content: 'MZ' },
      { name: 'b.lnk', content: 'L' },
    ]);

    const results = await unpack(['/src/pack.zip']);

    expect(results.map((r) => [r.entryName, r.error])).toEqual([
      ['a.exe', REFUSED_IMPORT_MESSAGE],
      ['b.lnk', REFUSED_IMPORT_MESSAGE],
    ]);
  });

  it('an archive without entries, or with only skipped ones, contains no files', async () => {
    const { unpack, archives, db } = await setup();
    archives.set('/src/empty.zip', []);
    archives.set('/src/dirs.zip', [{ name: 'tex/', isDirectory: true }, { name: '__MACOSX/._a.png', content: 'x' }]);

    const results = await unpack(['/src/empty.zip', '/src/dirs.zip']);

    expect(results).toEqual([failure('/src/empty.zip', ARCHIVE_EMPTY_MESSAGE), failure('/src/dirs.zip', ARCHIVE_EMPTY_MESSAGE)]);
    expect(db.files.records.size).toBe(0);
    expect(archives.closed).toBe(2);
  });
});

describe('importFiles archive limits', () => {
  it('has the limits of the spec', () => {
    expect(MAX_ARCHIVE_ENTRIES).toBe(5000);
    expect(MAX_ARCHIVE_BYTES).toBe(20 * 1024 ** 3);
    expect(new ArchiveTooLargeError().message).toBe(TOO_LARGE);
    expect(new ArchiveTooLargeError().code).toBe('validation_failed');
    expect(new ArchiveNotReadableError().message).toBe(NOT_A_ZIP);
    expect(new ArchiveNotReadableError().code).toBe('validation_failed');
  });

  it('refuses an archive with more entries than the limit before writing anything', async () => {
    const { unpack, archives, storage, db } = await setup();
    archives.set('/src/big.zip', [{ name: 'a.png', content: 'a' }, ...dirs(MAX_ARCHIVE_ENTRIES)]);

    const results = await unpack(['/src/big.zip']);

    expect(results).toEqual([failure('/src/big.zip', TOO_LARGE)]);
    expect(archives.opened).toEqual([{ path: '/src/big.zip', maxEntries: MAX_ARCHIVE_ENTRIES }]);
    expect(archives.openedEntries).toEqual([]);
    expect(archives.closed).toBe(1);
    expect(db.files.records.size).toBe(0);
    expect(written(storage)).toEqual([]);
  });

  it('refuses an archive whose declared sizes exceed the limit before writing anything', async () => {
    const { unpack, archives, storage, db } = await setup();
    archives.set('/src/big.zip', [
      { name: 'a.bin', content: 'a', declaredSize: MAX_ARCHIVE_BYTES / 2 },
      { name: 'b.bin', content: 'b', declaredSize: MAX_ARCHIVE_BYTES / 2 + 1 },
    ]);

    expect(await unpack(['/src/big.zip'])).toEqual([failure('/src/big.zip', TOO_LARGE)]);
    expect(archives.openedEntries).toEqual([]);
    expect(db.files.records.size).toBe(0);
    expect(written(storage)).toEqual([]);
  });

  it('the entry limit holds for the whole call; a refused archive leaves the budget and later sources untouched', async () => {
    const { unpack, archives, sources } = await setup();
    sources.set('/src/a.png', Buffer.from('a'));
    sources.set('/src/b.png', Buffer.from('b'));
    archives.set('/src/first.zip', [...dirs(2999), { name: 'first.png', content: 'f' }]);
    archives.set('/src/second.zip', [...dirs(2999), { name: 'second.png', content: 's' }]);
    archives.set('/src/third.zip', [...dirs(1999), { name: 'third.png', content: 't' }]);

    const results = await unpack(['/src/a.png', '/src/first.zip', '/src/second.zip', '/src/third.zip', '/src/b.png']);

    expect(results.map((r) => [r.sourcePath, r.entryName, r.file?.status ?? null, r.error])).toEqual([
      ['/src/a.png', null, 'complete', null],
      ['/src/first.zip', 'first.png', 'complete', null],
      ['/src/second.zip', null, null, TOO_LARGE],
      ['/src/third.zip', 'third.png', 'complete', null],
      ['/src/b.png', null, 'complete', null],
    ]);
    expect(archives.opened.map((o) => o.maxEntries)).toEqual([5000, 2000, 2000]);
    expect(archives.closed).toBe(3);
  });

  it('the size limit holds for the whole call', async () => {
    const { unpack, archives } = await setup();
    archives.set('/src/first.zip', [{ name: 'first.bin', content: 'f', declaredSize: MAX_ARCHIVE_BYTES - 1 }]);
    archives.set('/src/second.zip', [{ name: 'second.bin', content: 'ss', declaredSize: 2 }]);
    archives.set('/src/third.zip', [{ name: 'third.bin', content: 't', declaredSize: 1 }]);

    const results = await unpack(['/src/first.zip', '/src/second.zip', '/src/third.zip']);

    expect(results.map((r) => [r.entryName, r.error])).toEqual([
      ['first.bin', null],
      [null, TOO_LARGE],
      ['third.bin', null],
    ]);
  });
});

describe('importFiles archive failures', () => {
  it('a file that is not a ZIP answers the archive-level message', async () => {
    const { unpack, archives, db } = await setup();
    archives.set('/src/fake.zip', 'not-zip');

    expect(await unpack(['/src/fake.zip'])).toEqual([failure('/src/fake.zip', NOT_A_ZIP)]);
    expect(db.files.records.size).toBe(0);
  });

  it('an unreadable archive answers like an unreadable plain file', async () => {
    const { manager, unpack } = await setup();
    const [plain] = await manager.importFiles(['/src/missing.zip']);

    const results = await unpack(['/src/missing.zip']);

    expect(plain!.error).not.toBeNull();
    expect(results).toEqual([failure('/src/missing.zip', plain!.error!)]);
  });

  it('a failing entry stream fails that entry only and leaves no staging file', async () => {
    const { unpack, archives, storage, db } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'broken.png', content: 'broken', failStream: true },
      { name: 'fine.png', content: 'fine' },
    ]);

    const [broken, fine] = await unpack(['/src/pack.zip']);

    expect(broken).toMatchObject({ entryName: 'broken.png', error: 'Import failed', file: { status: 'failed', originalName: 'broken.png' } });
    expect(db.files.records.get(broken!.file!.id)).toMatchObject({ status: 'failed', error: 'Import failed' });
    expect(fine).toMatchObject({ entryName: 'fine.png', error: null, file: { status: 'complete', sha256: sha('fine') } });
    expect(stagingEntries(storage)).toEqual([]);
    expect(written(storage)).toEqual([fine!.file!.relativePath]);
  });

  it('an archive that cannot be read to the end reports every entry not started', async () => {
    const { unpack, archives, db } = await setup();
    archives.set('/src/pack.zip', [
      { name: 'one.png', content: 'one' },
      { name: 'two.png', content: 'two', failOpen: true },
      { name: 'three.exe', content: 'MZ' },
      { name: 'dir/', isDirectory: true },
    ]);

    const results = await unpack(['/src/pack.zip']);

    expect(results[0]).toMatchObject({ entryName: 'one.png', error: null, file: { status: 'complete' } });
    expect(results.slice(1)).toEqual([
      { sourcePath: '/src/pack.zip', entryName: 'two.png', file: null, error: ARCHIVE_TRUNCATED_MESSAGE, duplicateOf: [] },
      { sourcePath: '/src/pack.zip', entryName: 'three.exe', file: null, error: ARCHIVE_TRUNCATED_MESSAGE, duplicateOf: [] },
    ]);
    expect([...db.files.records.values()].map((r) => r.originalName)).toEqual(['one.png']);
    expect(archives.openedEntries).toEqual([0, 1]);
    expect(archives.closed).toBe(1);
  });

  it('an entry whose content already exists reports the earlier file', async () => {
    const { unpack, archives, sources } = await setup();
    sources.set('/src/a.png', Buffer.from('same'));
    archives.set('/src/pack.zip', [
      { name: 'copy.png', content: 'same' },
      { name: 'again.png', content: 'same' },
    ]);

    const [plain, copy, again] = await unpack(['/src/a.png', '/src/pack.zip']);

    expect(copy!.duplicateOf).toEqual([plain!.file!.id]);
    expect(again!.duplicateOf.sort()).toEqual([plain!.file!.id, copy!.file!.id].sort());
  });

  it('a pending row left by an interrupted entry import is cleaned on open', async () => {
    const { manager, unpack, archives, storage, db } = await setup();
    archives.set('/src/pack.zip', [{ name: 'cut.png', content: 'cut', failStream: true }]);
    db.files.markFailed = async () => {
      throw new Error('db gone');
    };
    const [result] = await unpack(['/src/pack.zip']);
    delete (db.files as { markFailed?: unknown }).markFailed;
    expect(db.files.records.get(result!.file!.id)?.status).toBe('pending');

    await manager.close();
    await manager.open({ rootPath: ROOT });

    expect(db.files.records.get(result!.file!.id)).toMatchObject({ status: 'failed', error: 'Import was interrupted' });
    expect(stagingEntries(storage)).toEqual([]);
  });
});
