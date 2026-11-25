import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  resolveFilePath,
  resolvePreviewSource,
  StorageUnreachableError,
  ValidationFailedError,
  WorkspaceManager,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

async function setup(name = 'pump.png', content = 'pump') {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  fake.sources.set(`/src/${name}`, Buffer.from(content));
  const [imported] = await manager.importFiles([`/src/${name}`]);
  return { session, storage, db, file: imported!.file! };
}

describe('resolvePreviewSource', () => {
  it('returns sha256 and path for a complete image', async () => {
    const { session, file } = await setup();
    const source = await resolvePreviewSource(session, file.id);
    expect(source).toEqual({ sha256: file.sha256, absolutePath: `/memory/${file.relativePath}` });
  });

  it('ignores files that are not complete', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, status: 'pending' });
    expect(await resolvePreviewSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, status: 'failed', error: 'x' });
    expect(await resolvePreviewSource(session, file.id)).toBeNull();
    expect(await resolvePreviewSource(session, UNKNOWN_ID)).toBeNull();
  });

  it('propagates StorageUnreachableError when the storage is unreachable', async () => {
    const { session, storage, file } = await setup();
    storage.reachable = false;
    await expect(resolvePreviewSource(session, file.id)).rejects.toBeInstanceOf(StorageUnreachableError);
  });

  it('ignores non-previewable files and rows without a checksum', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, mimeType: 'application/pdf' });
    expect(await resolvePreviewSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, sha256: null });
    expect(await resolvePreviewSource(session, file.id)).toBeNull();
  });
});

describe('resolveFilePath', () => {
  it('rejects unknown and incomplete files with not_found', async () => {
    const { session, db, file } = await setup();
    await expect(resolveFilePath(session, UNKNOWN_ID, 'open')).rejects.toBeInstanceOf(NotFoundError);
    db.files.records.set(file.id, { ...file, status: 'pending' });
    await expect(resolveFilePath(session, file.id, 'reveal')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('for open rejects blocked files with validation_failed', async () => {
    const { session, storage, db, file } = await setup();
    const blockedPath = file.relativePath.replace(/\.png$/, '.exe');
    storage.files.set(blockedPath, storage.files.get(file.relativePath)!);
    db.files.records.set(file.id, { ...file, relativePath: blockedPath });
    await expect(resolveFilePath(session, file.id, 'open')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await resolveFilePath(session, file.id, 'reveal')).toBe(`/memory/${blockedPath}`);
  });

  it('reports storage_unreachable without a path', async () => {
    const { session, storage, file } = await setup();
    storage.reachable = false;
    const error = await resolveFilePath(session, file.id, 'open').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUnreachableError);
    const message = (error as Error).message;
    expect(message).not.toContain('/');
    expect(message).not.toContain('\\');
  });

  it('reports a file missing on disk as not_found without a path', async () => {
    const { session, storage, file } = await setup();
    storage.files.delete(file.relativePath);
    const error = await resolveFilePath(session, file.id, 'open').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    const message = (error as Error).message;
    expect(message).not.toContain('/');
    expect(message).not.toContain('\\');
  });

  it('returns the path for a normal file', async () => {
    const { session, file } = await setup();
    expect(await resolveFilePath(session, file.id, 'open')).toBe(`/memory/${file.relativePath}`);
  });
});
