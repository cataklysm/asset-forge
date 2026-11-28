import { describe, expect, it } from 'vitest';
import {
  InvalidOperationError,
  NotFoundError,
  resolveFilePath,
  resolveOriginalSource,
  resolvePreviewSource,
  resolveVideoSource,
  StorageUnreachableError,
  ValidationFailedError,
  WorkspaceManager,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, trashForTest } from './fakes.js';

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
    expect(source).toEqual({ sha256: file.sha256, absolutePath: `/memory/${file.relativePath}`, video: null });
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

describe('resolveOriginalSource', () => {
  it('returns path and stored type for a complete native image up to the edge limit', async () => {
    const { session, db, file } = await setup('photo.jpg');
    db.files.records.set(file.id, { ...file, mimeType: 'image/jpeg', width: 7680, height: 4320 });
    expect(await resolveOriginalSource(session, file.id)).toEqual({
      absolutePath: `/memory/${file.relativePath}`,
      mimeType: 'image/jpeg',
    });
  });

  it('serves an imported png whose dimensions were measured', async () => {
    const { session, file } = await setup();
    expect(file).toMatchObject({ mimeType: 'image/png', width: 640, height: 480 });
    expect(await resolveOriginalSource(session, file.id)).toEqual({
      absolutePath: `/memory/${file.relativePath}`,
      mimeType: 'image/png',
    });
  });

  it('ignores unknown files', async () => {
    const { session } = await setup();
    expect(await resolveOriginalSource(session, UNKNOWN_ID)).toBeNull();
  });

  it('ignores pending and failed files', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, status: 'pending' });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, status: 'failed', error: 'x' });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it('ignores a complete file without checksum', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, sha256: null });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it.each(['image/tiff', 'image/svg+xml', 'text/html', 'IMAGE/PNG'])('ignores %s', async (mimeType) => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, mimeType });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it('ignores unknown dimensions', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, width: null, height: null });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, width: 100, height: null });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it('ignores an image above the edge limit', async () => {
    const { session, db, file } = await setup();
    db.files.records.set(file.id, { ...file, width: 8193, height: 10 });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, width: 10, height: 8193 });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it('ignores a text file imported as png, whose dimensions could not be measured', async () => {
    const fake = createFakeHost();
    fake.probe.result = null;
    const manager = new WorkspaceManager(fake.host);
    await manager.create({ name: 'Demo', rootPath: ROOT });
    fake.sources.set('/src/x.png', Buffer.from('<html><script>alert(1)</script></html>'));
    const [imported] = await manager.importFiles(['/src/x.png']);
    const file = imported!.file!;
    expect(file).toMatchObject({ status: 'complete', mimeType: 'image/png', width: null, height: null });
    expect(await manager.read((s) => resolveOriginalSource(s, file.id))).toBeNull();
  });

  it('propagates StorageUnreachableError when the storage is unreachable', async () => {
    const { session, storage, file } = await setup();
    storage.reachable = false;
    await expect(resolveOriginalSource(session, file.id)).rejects.toBeInstanceOf(StorageUnreachableError);
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

describe('trashed files', () => {
  it('resolveFilePath refuses a trashed file for open and reveal', async () => {
    const { session, file } = await setup();
    await trashForTest(session, [file.id]);
    for (const purpose of ['open', 'reveal'] as const) {
      const error = await resolveFilePath(session, file.id, purpose).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidOperationError);
      expect((error as Error).message).toBe('The file is in the trash');
    }
  });

  it('resolvePreviewSource and resolveOriginalSource still serve it', async () => {
    const { session, db, file } = await setup();
    await trashForTest(session, [file.id]);
    const trashed = (await db.files.get(file.id))!;
    expect(await resolvePreviewSource(session, file.id)).toEqual({
      sha256: file.sha256,
      absolutePath: `/memory/${trashed.relativePath}`,
      video: null,
    });
    expect(file.width).not.toBeNull();
    expect(await resolveOriginalSource(session, file.id)).toMatchObject({
      absolutePath: `/memory/${trashed.relativePath}`,
    });
  });
});

describe('videos', () => {
  it('resolvePreviewSource answers the format of a complete video', async () => {
    const { session, file } = await setup('clip.mp4');
    expect(file).toMatchObject({ kind: 'video', mimeType: 'video/mp4', thumbnail: true, previewable: false });
    expect(await resolvePreviewSource(session, file.id)).toEqual({
      sha256: file.sha256,
      absolutePath: `/memory/${file.relativePath}`,
      video: 'mp4',
    });
    const webm = await setup('clip.webm');
    expect(await resolvePreviewSource(webm.session, webm.file.id)).toMatchObject({ video: 'webm' });
  });

  it('resolveOriginalSource never serves a video', async () => {
    const { session, db, file } = await setup('clip.mp4');
    db.files.records.set(file.id, { ...file, width: 640, height: 360 });
    expect(await resolveOriginalSource(session, file.id)).toBeNull();
  });

  it('resolveVideoSource answers path and type of a complete video, also in the trash', async () => {
    const { session, db, file } = await setup('clip.webm');
    expect(await resolveVideoSource(session, file.id)).toEqual({
      absolutePath: `/memory/${file.relativePath}`,
      mimeType: 'video/webm',
    });
    await trashForTest(session, [file.id]);
    const trashed = (await db.files.get(file.id))!;
    expect(await resolveVideoSource(session, file.id)).toEqual({
      absolutePath: `/memory/${trashed.relativePath}`,
      mimeType: 'video/webm',
    });
  });

  it('resolveVideoSource refuses incomplete files, rows without a checksum and other types', async () => {
    const { session, db, file } = await setup('clip.mp4');
    db.files.records.set(file.id, { ...file, status: 'pending' });
    expect(await resolveVideoSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, status: 'failed', error: 'x' });
    expect(await resolveVideoSource(session, file.id)).toBeNull();
    db.files.records.set(file.id, { ...file, sha256: null });
    expect(await resolveVideoSource(session, file.id)).toBeNull();
    for (const mimeType of ['image/png', 'video/quicktime', 'VIDEO/MP4', 'application/octet-stream']) {
      db.files.records.set(file.id, { ...file, mimeType });
      expect(await resolveVideoSource(session, file.id)).toBeNull();
    }
    expect(await resolveVideoSource(session, UNKNOWN_ID)).toBeNull();
    const image = await setup();
    expect(await resolveVideoSource(image.session, image.file.id)).toBeNull();
  });

  it('only the original answers unreachable when absolutePath itself does not check', async () => {
    const image = await setup();
    const video = await setup('clip.mp4');
    for (const { storage } of [image, video]) {
      // Like the local adapter: absolutePath only joins paths and never asks whether the share is there.
      storage.absolutePath = async (relativePath: string) => `/memory/${relativePath}`;
      storage.reachable = false;
    }
    await expect(resolveOriginalSource(image.session, image.file.id)).rejects.toBeInstanceOf(StorageUnreachableError);
    // A cached preview is still served from the cache, and every range request of a video skips the check.
    await expect(resolvePreviewSource(image.session, image.file.id)).resolves.toMatchObject({
      sha256: image.file.sha256,
      absolutePath: `/memory/${image.file.relativePath}`,
    });
    await expect(resolveVideoSource(video.session, video.file.id)).resolves.toMatchObject({
      absolutePath: `/memory/${video.file.relativePath}`,
    });
  });

  it('resolveVideoSource propagates StorageUnreachableError', async () => {
    const { session, storage, file } = await setup('clip.mp4');
    storage.reachable = false;
    await expect(resolveVideoSource(session, file.id)).rejects.toBeInstanceOf(StorageUnreachableError);
  });
});
