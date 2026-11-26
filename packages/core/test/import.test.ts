import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  importFile,
  inboxPath,
  REFUSED_IMPORT_MESSAGE,
  SourceNotReadableError,
  STAGING_DIR,
  StorageFullError,
  WorkspaceManager,
  type ImportContext,
  type SourceFiles,
} from '../src/index.js';
import { createFakeHost, trashForTest, type InMemoryStorage } from './fakes.js';

const ROOT = '/ws/a';
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const STORAGE_ID = '99999999-9999-4999-8999-999999999999';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const ctx: ImportContext = {
    storage,
    storageId: STORAGE_ID,
    files: db.files,
    sources: fake.sources,
    probe: fake.probe,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
  return { ...fake, manager, storage, db, ctx };
}

const stagingEntries = (storage: InMemoryStorage) => [...storage.files.keys()].filter((k) => k.startsWith(`${STAGING_DIR}/`));
const inboxEntries = (storage: InMemoryStorage) => [...storage.files.keys()].filter((k) => k.startsWith('inbox/'));

describe('importFile', () => {
  it('imports a file through staging into the inbox', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    const result = await importFile(ctx, '/src/ref.png');

    expect(result.error).toBeNull();
    expect(result.duplicateOf).toEqual([]);
    expect(result.sourcePath).toBe('/src/ref.png');
    expect(result.entryName).toBeNull();
    const file = result.file!;
    expect(file.status).toBe('complete');
    expect(file.sizeBytes).toBe(5);
    expect(file.sha256).toBe(HELLO_SHA);
    expect(file.relativePath).toBe(`inbox/${file.id}_ref.png`);
    expect(file.mimeType).toBe('image/png');
    expect(file.originalName).toBe('ref.png');
    expect(storage.files.get(file.relativePath)?.toString()).toBe('hello');
    expect(stagingEntries(storage)).toEqual([]);
    expect(sources.get('/src/ref.png')?.toString()).toBe('hello');
  });

  it('stores the storage id on the imported file', async () => {
    const { ctx, sources, storage, db } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    const pendingRows: { storageId: string }[] = [];
    const files = Object.create(ctx.files) as ImportContext['files'];
    files.insertPending = async (r) => {
      pendingRows.push(r);
      return ctx.files.insertPending(r);
    };
    const ok = await importFile({ ...ctx, files }, '/src/ref.png');
    expect(pendingRows.map((r) => r.storageId)).toEqual([STORAGE_ID]);
    expect(ok.file).toMatchObject({ storageId: STORAGE_ID, role: null });
    expect(db.files.records.get(ok.file!.id)).toMatchObject({ storageId: STORAGE_ID, role: null });

    sources.set('/src/bad.png', Buffer.from('x'));
    storage.failNext('move', new Error('rename failed'));
    const failed = await importFile(ctx, '/src/bad.png');
    expect(failed.file).toMatchObject({ status: 'failed', storageId: STORAGE_ID, role: null });
  });

  it('imports the same source twice as separate records and reports the duplicate', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    const first = await importFile(ctx, '/src/ref.png');
    const second = await importFile(ctx, '/src/ref.png');

    expect(second.file!.id).not.toBe(first.file!.id);
    expect(second.file!.relativePath).not.toBe(first.file!.relativePath);
    expect(second.file!.status).toBe('complete');
    expect(first.duplicateOf).toEqual([]);
    expect(second.duplicateOf).toEqual([first.file!.id]);
    expect(inboxEntries(storage)).toHaveLength(2);
  });

  it('keeps two different sources with the same name', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/one/a.png', Buffer.from('one'));
    sources.set('/two/a.png', Buffer.from('two'));
    const a = await importFile(ctx, '/one/a.png');
    const b = await importFile(ctx, '/two/a.png');

    expect(a.file!.status).toBe('complete');
    expect(b.file!.status).toBe('complete');
    expect(a.file!.relativePath).not.toBe(b.file!.relativePath);
    expect(storage.files.get(a.file!.relativePath)?.toString()).toBe('one');
    expect(storage.files.get(b.file!.relativePath)?.toString()).toBe('two');
  });

  it('processes a batch in input order and isolates per-file failures', async () => {
    const { manager, sources, db } = await setup();
    sources.set('/src/dir', Buffer.from('x'));
    sources.unreadable.add('/src/dir');
    sources.set('/src/ok.png', Buffer.from('ok'));
    const results = await manager.importFiles(['/src/missing.png', '/src/dir', '/src/ok.png']);

    expect(results.map((r) => r.sourcePath)).toEqual(['/src/missing.png', '/src/dir', '/src/ok.png']);
    expect(results[0]!.file).toBeNull();
    expect(results[0]!.error).toBeTruthy();
    expect(results[1]!.file).toBeNull();
    expect(results[1]!.error).toBeTruthy();
    expect(results[2]!.file!.status).toBe('complete');
    const primary = await db.storages.getPrimary();
    expect(results[2]!.file!.storageId).toBe(primary!.id);
    expect((await manager.listFiles({ limit: 10, offset: 0, scope: { kind: 'all' } })).total).toBe(1);
  });

  it('neutralizes path components in the source name', async () => {
    const { ctx } = await setup();
    const name = '..\\..\\Größe über alles.JPG';
    const sources: SourceFiles = { open: async () => ({ name, stream: Readable.from([Buffer.from('x')]) }) };
    const result = await importFile({ ...ctx, sources }, '/src/odd');

    const file = result.file!;
    expect(file.relativePath.startsWith('inbox/')).toBe(true);
    expect(file.relativePath).not.toContain('..');
    expect(file.relativePath.slice('inbox/'.length)).not.toMatch(/[\\/]/);
    expect(file.originalName).toBe(name);
    expect(file.relativePath).toBe(inboxPath(file.id, name));
  });

  it('marks the record failed when writing to staging fails', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/src/a.png', Buffer.from('x'));
    storage.failNext('writeStream', new Error('disk full'));
    const result = await importFile(ctx, '/src/a.png');

    expect(result.error).toBe('Import failed');
    expect(result.file!.status).toBe('failed');
    expect(result.file!.error).toBe('Import failed');
    expect(stagingEntries(storage)).toEqual([]);
    expect(inboxEntries(storage)).toEqual([]);
  });

  it('fails on a checksum mismatch', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/src/a.png', Buffer.from('x'));
    storage.hashOverride = '0'.repeat(64);
    const result = await importFile(ctx, '/src/a.png');

    expect(result.file!.status).toBe('failed');
    expect(result.error).toMatch(/checksum/i);
    expect(result.file!.error).toBe(result.error);
    expect(stagingEntries(storage)).toEqual([]);
    expect(inboxEntries(storage)).toEqual([]);
  });

  it('fails cleanly when the move fails', async () => {
    const { ctx, sources, storage } = await setup();
    sources.set('/src/a.png', Buffer.from('x'));
    storage.failNext('move', new Error('rename failed'));
    const result = await importFile(ctx, '/src/a.png');

    expect(result.file!.status).toBe('failed');
    expect(result.error).toBe('Import failed');
    expect(stagingEntries(storage)).toEqual([]);
    expect(inboxEntries(storage)).toEqual([]);
  });

  it('imports a zero-byte file', async () => {
    const { ctx, sources } = await setup();
    sources.set('/src/empty.txt', Buffer.alloc(0));
    const result = await importFile(ctx, '/src/empty.txt');

    expect(result.file!.status).toBe('complete');
    expect(result.file!.sizeBytes).toBe(0);
    expect(result.file!.sha256).toBe(EMPTY_SHA);
  });

  it('destroys the source stream when insertPending fails', async () => {
    const { ctx, storage } = await setup();
    const stream = Readable.from([Buffer.from('x')]);
    const sources: SourceFiles = { open: async () => ({ name: 'a.png', stream }) };
    const files = Object.create(ctx.files) as ImportContext['files'];
    files.insertPending = async () => {
      throw new Error('db locked');
    };
    const result = await importFile({ ...ctx, sources, files }, '/src/a.png');

    expect(result.file).toBeNull();
    expect(result.error).toBe('Import failed');
    expect(stream.destroyed).toBe(true);
    expect(stagingEntries(storage)).toEqual([]);
  });

  it('destroys the source stream when writeStream fails before consuming it', async () => {
    const { ctx, storage } = await setup();
    const stream = Readable.from([Buffer.from('x')]);
    const sources: SourceFiles = { open: async () => ({ name: 'a.png', stream }) };
    const failing = Object.create(storage) as InMemoryStorage;
    failing.writeStream = async () => {
      throw new Error('early failure');
    };
    const result = await importFile({ ...ctx, storage: failing, sources }, '/src/a.png');

    expect(result.file!.status).toBe('failed');
    expect(stream.destroyed).toBe(true);
  });

  it('never deletes an existing file at the final path when the move fails', async () => {
    const { ctx, sources, storage } = await setup();
    const id = '44444444-4444-4444-8444-444444444444';
    const existing = inboxPath(id, 'a.png');
    storage.files.set(existing, Buffer.from('existing'));
    sources.set('/src/a.png', Buffer.from('new'));
    const result = await importFile({ ...ctx, newId: () => id }, '/src/a.png');

    expect(result.file!.status).toBe('failed');
    expect(storage.files.get(existing)?.toString()).toBe('existing');
    expect(stagingEntries(storage)).toEqual([]);
  });

  it('removes the moved inbox file when markComplete fails', async () => {
    const { ctx, sources, storage, db } = await setup();
    sources.set('/src/a.png', Buffer.from('x'));
    const files = Object.create(ctx.files) as ImportContext['files'];
    files.markComplete = async () => {
      throw new Error('commit failed');
    };
    const result = await importFile({ ...ctx, files }, '/src/a.png');

    expect(result.file!.status).toBe('failed');
    expect(result.error).toBe('Import failed');
    expect(inboxEntries(storage)).toEqual([]);
    expect([...db.files.records.values()].map((r) => r.status)).toEqual(['failed']);
  });

  describe('error text', () => {
    const ABSOLUTE = 'C:\\Users\\someone\\workspace\\.assetforge\\staging\\x.part';
    const errnoError = (code: unknown) =>
      Object.assign(new Error(`${String(code)}: operation failed, open '${ABSOLUTE}'`), { code });

    it('replaces a non-domain error by "Import failed (<code>)" in the result and the record', async () => {
      const { ctx, sources, storage, db } = await setup();
      sources.set('/src/a.png', Buffer.from('x'));
      storage.failNext('writeStream', errnoError('EBUSY'));
      const result = await importFile(ctx, '/src/a.png');

      expect(result.error).toBe('Import failed (EBUSY)');
      expect(result.file!.error).toBe('Import failed (EBUSY)');
      expect(db.files.records.get(result.file!.id)!.error).toBe('Import failed (EBUSY)');
    });

    it('drops a code that is not a short identifier', async () => {
      for (const code of [42, ABSOLUTE, 'E'.repeat(40)]) {
        const { ctx, sources, storage, db } = await setup();
        sources.set('/src/a.png', Buffer.from('x'));
        storage.failNext('move', errnoError(code));
        const result = await importFile(ctx, '/src/a.png');

        expect(result.error).toBe('Import failed');
        expect(db.files.records.get(result.file!.id)!.error).toBe('Import failed');
      }
    });

    it('keeps the message of a domain error', async () => {
      const { ctx, sources, storage, db } = await setup();
      sources.set('/src/a.png', Buffer.from('x'));
      storage.failNext('writeStream', new StorageFullError('Not enough free space to write .assetforge/staging/x.part'));
      const result = await importFile(ctx, '/src/a.png');

      expect(result.error).toBe('Not enough free space to write .assetforge/staging/x.part');
      expect(db.files.records.get(result.file!.id)!.error).toBe(result.error);
    });

    it('applies the same rule to errors from opening the source', async () => {
      const { ctx } = await setup();
      const raw: SourceFiles = {
        open: async () => {
          throw errnoError('EBUSY');
        },
      };
      expect((await importFile({ ...ctx, sources: raw }, '/src/a.png')).error).toBe('Import failed (EBUSY)');

      const domain: SourceFiles = {
        open: async () => {
          throw new SourceNotReadableError('Cannot read source file: /src/a.png');
        },
      };
      expect((await importFile({ ...ctx, sources: domain }, '/src/a.png')).error).toBe(
        'Cannot read source file: /src/a.png',
      );
    });
  });

  it('does not reject when markFailed itself throws', async () => {
    const { ctx, sources, storage, db } = await setup();
    sources.set('/src/a.png', Buffer.from('x'));
    storage.failNext('move', new Error('rename failed'));
    const files = Object.create(ctx.files) as ImportContext['files'];
    files.markFailed = async () => {
      throw new Error('db gone');
    };
    const result = await importFile({ ...ctx, files }, '/src/a.png');

    expect(result.error).toBe('Import failed');
    expect(result.file?.status).toBe('failed');
    expect([...db.files.records.values()].map((r) => r.status)).toEqual(['pending']);
  });
});

describe('refused imports', () => {
  it('a refused extension fails only its own file and leaves nothing behind', async () => {
    const { manager, sources, storage, db } = await setup();
    const refused = ['/src/Setup.EXE.', '/src/a.txt.exe', '/src/.bat'];
    for (const p of [...refused, '/src/ok.png']) sources.set(p, Buffer.from('hello'));
    const results = await manager.importFiles([...refused, '/src/ok.png']);

    for (const result of results.slice(0, 3)) {
      expect(result.file).toBeNull();
      expect(result.error).toBe(REFUSED_IMPORT_MESSAGE);
      expect(result.error).not.toContain('/src');
    }
    expect(results[3]!.file?.status).toBe('complete');
    expect(db.files.records.size).toBe(1);
    expect(stagingEntries(storage)).toEqual([]);
    expect(sources.opened).toEqual(['/src/ok.png']);
  });

  it('importFile refuses before opening the source', async () => {
    const { ctx, sources } = await setup();
    sources.set('/src/tool.exe', Buffer.from('x'));
    let inserted = 0;
    const files = Object.create(ctx.files) as ImportContext['files'];
    files.insertPending = async (r) => {
      inserted += 1;
      return ctx.files.insertPending(r);
    };
    const result = await importFile({ ...ctx, files }, '/src/tool.exe');
    expect(result).toEqual({ sourcePath: '/src/tool.exe', entryName: null, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] });
    expect(sources.opened).toEqual([]);
    expect(inserted).toBe(0);
  });

  it('importFile refuses a Windows path to an alternate data stream', async () => {
    const { ctx, sources } = await setup();
    for (const p of ['C:\\x\\a.exe::$DATA', 'C:\\x\\a.exe:stream', 'C:\\x\\evil.txt:payload.exe']) {
      sources.set(p, Buffer.from('x'));
      const result = await importFile(ctx, p);
      expect(result).toEqual({ sourcePath: p, entryName: null, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] });
    }
    expect(sources.opened).toEqual([]);
  });
});

describe('importFile measuring', () => {
  it('stores the size measured at the final inbox path', async () => {
    const { ctx, sources, storage, probe } = await setup();
    sources.set('/src/a.png', Buffer.from('hello'));
    const result = await importFile(ctx, '/src/a.png');
    const file = result.file!;
    expect(probe.calls).toEqual([`/memory/${file.relativePath}`]);
    expect(storage.files.has(file.relativePath)).toBe(true);
    expect([file.width, file.height]).toEqual([640, 480]);
    expect(await ctx.files.get(file.id)).toMatchObject({ width: 640, height: 480 });
  });

  it('does not measure a file that is not previewable', async () => {
    const { ctx, sources, probe } = await setup();
    sources.set('/src/notes.txt', Buffer.from('hello'));
    const file = (await importFile(ctx, '/src/notes.txt')).file!;
    expect(probe.calls).toEqual([]);
    expect([file.width, file.height]).toEqual([null, null]);
  });

  it.each([
    ['resolves null', (p: { result: unknown }) => (p.result = null)],
    ['rejects', (p: { failure: Error | null }) => (p.failure = new Error('/secret/path broke'))],
  ])('stays complete without dimensions when the probe %s', async (_name, configure) => {
    const { ctx, sources, probe } = await setup();
    configure(probe as never);
    sources.set('/src/a.png', Buffer.from('hello'));
    const result = await importFile(ctx, '/src/a.png');
    expect(result.error).toBeNull();
    expect(result.file).toMatchObject({ status: 'complete', error: null, width: null, height: null });
    expect(await ctx.files.get(result.file!.id)).toMatchObject({ status: 'complete', width: null, height: null });
  });

  it('never measures a failed import', async () => {
    const { ctx, sources, storage, probe } = await setup();
    sources.set('/src/a.png', Buffer.from('hello'));
    storage.hashOverride = 'f'.repeat(64);
    const result = await importFile(ctx, '/src/a.png');
    expect(result.file?.status).toBe('failed');
    expect(probe.calls).toEqual([]);
  });
});

describe('importing the content of a trashed file', () => {
  it('an import of the same content as a trashed file is not a duplicate', async () => {
    const { manager, sources } = await setup();
    sources.set('/src/a.png', Buffer.from('same'));
    sources.set('/src/b.png', Buffer.from('same'));
    const [first] = await manager.importFiles(['/src/a.png']);
    const session = await manager.read(async (s) => s);
    await trashForTest(session, [first!.file!.id]);
    const [second] = await manager.importFiles(['/src/b.png']);
    expect(second!.duplicateOf).toEqual([]);
  });
});
