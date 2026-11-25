import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { importFile, inboxPath, STAGING_DIR, WorkspaceManager, type ImportContext, type SourceFiles } from '../src/index.js';
import { createFakeHost, type InMemoryStorage } from './fakes.js';

const ROOT = '/ws/a';
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const ctx: ImportContext = {
    storage,
    files: db.files,
    sources: fake.sources,
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
    const { manager, sources } = await setup();
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
    expect((await manager.listFiles({ limit: 10, offset: 0 })).total).toBe(1);
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

    expect(result.error).toBe('disk full');
    expect(result.file!.status).toBe('failed');
    expect(result.file!.error).toBe('disk full');
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
    expect(result.error).toBe('rename failed');
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
    expect(result.error).toBe('db locked');
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
    expect(result.error).toBe('commit failed');
    expect(inboxEntries(storage)).toEqual([]);
    expect([...db.files.records.values()].map((r) => r.status)).toEqual(['failed']);
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

    expect(result.error).toBe('rename failed');
    expect(result.file?.status).toBe('failed');
    expect([...db.files.records.values()].map((r) => r.status)).toEqual(['pending']);
  });
});
