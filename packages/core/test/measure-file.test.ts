import { describe, expect, it } from 'vitest';
import { measureFile, NotFoundError, StorageUnreachableError, WorkspaceManager } from '../src/index.js';
import { createFakeHost, trashForTest } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

/** Imports `name` while the probe yields nothing, so the file is complete without dimensions. */
async function setup(name = 'pump.png') {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session = await manager.read(async (s) => s);
  fake.probe.result = null;
  fake.sources.set(`/src/${name}`, Buffer.from('pump'));
  const file = (await manager.importFiles([`/src/${name}`]))[0]!.file!;
  fake.probe.calls.length = 0;
  fake.probe.result = { width: 800, height: 600 };
  return { session, storage, db, file, probe: fake.probe };
}

describe('measureFile', () => {
  it('measures a complete previewable file and stores the size', async () => {
    const { session, db, file, probe } = await setup();
    const measured = await measureFile(session, file.id);
    expect(probe.calls).toEqual([`/memory/${file.relativePath}`]);
    expect(measured).toMatchObject({ id: file.id, width: 800, height: 600 });
    expect(await db.files.get(file.id)).toMatchObject({ width: 800, height: 600 });
  });

  it('is idempotent', async () => {
    const { session, file, probe } = await setup();
    const first = await measureFile(session, file.id);
    const second = await measureFile(session, file.id);
    expect(probe.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('leaves the record unchanged when the probe yields nothing or fails', async () => {
    const { session, db, file, probe } = await setup();
    probe.result = null;
    expect(await measureFile(session, file.id)).toEqual(file);
    probe.failure = new Error('/secret/path broke');
    expect(await measureFile(session, file.id)).toEqual(file);
    expect(await db.files.get(file.id)).toMatchObject({ width: null, height: null });
  });

  it('does not measure pending, failed or non-previewable files', async () => {
    const { session, db, file, probe } = await setup();
    db.files.records.set(file.id, { ...file, status: 'pending' });
    expect((await measureFile(session, file.id)).status).toBe('pending');
    db.files.records.set(file.id, { ...file, status: 'failed', error: 'x' });
    expect((await measureFile(session, file.id)).status).toBe('failed');

    const text = await setup('notes.txt');
    expect(await measureFile(text.session, text.file.id)).toEqual(text.file);
    expect([probe.calls, text.probe.calls]).toEqual([[], []]);
  });

  it('rejects an unknown id', async () => {
    const { session } = await setup();
    await expect(measureFile(session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaves a file that is missing on disk unchanged', async () => {
    const { session, storage, file, probe } = await setup();
    storage.files.delete(file.relativePath);
    expect(await measureFile(session, file.id)).toEqual(file);
    expect(probe.calls).toEqual([]);
  });

  it('rejects with StorageUnreachableError when the storage is unreachable', async () => {
    const { session, storage, file, probe } = await setup();
    storage.reachable = false;
    await expect(measureFile(session, file.id)).rejects.toBeInstanceOf(StorageUnreachableError);
    expect(probe.calls).toEqual([]);
  });
});

describe('measureFile of a video', () => {
  async function videoSetup(name = 'clip.mp4') {
    const fake = createFakeHost();
    const manager = new WorkspaceManager(fake.host);
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const db = fake.databases.get(summary.id)!;
    const session = await manager.read(async (s) => s);
    fake.sources.set(`/src/${name}`, Buffer.from('video'));
    fake.videoProbe.result = { width: 1920, height: 1080, durationMs: 4500 };
    const file = (await manager.importFiles([`/src/${name}`]))[0]!.file!;
    return { session, db, file, probe: fake.probe, videoProbe: fake.videoProbe };
  }

  it('the import does not measure a video', async () => {
    const { file, probe, videoProbe } = await videoSetup();
    expect(file).toMatchObject({ kind: 'video', mimeType: 'video/mp4', width: null, height: null, durationMs: null });
    expect([probe.calls, videoProbe.calls]).toEqual([[], []]);
  });

  it('measures a complete video on demand through the video probe and stores size and duration', async () => {
    const { session, db, file, probe, videoProbe } = await videoSetup();
    const measured = await measureFile(session, file.id);
    expect(videoProbe.calls).toEqual([{ absolutePath: `/memory/${file.relativePath}`, format: 'mp4' }]);
    expect(probe.calls).toEqual([]);
    expect(measured).toMatchObject({ id: file.id, width: 1920, height: 1080, durationMs: 4500 });
    expect(await db.files.get(file.id)).toMatchObject({ width: 1920, height: 1080, durationMs: 4500 });
    await measureFile(session, file.id);
    expect(videoProbe.calls).toHaveLength(1);
  });

  it('passes the webm format and stores an unknown duration as null', async () => {
    const { session, file, videoProbe } = await videoSetup('clip.webm');
    videoProbe.result = { width: 640, height: 360, durationMs: null };
    await expect(measureFile(session, file.id)).resolves.toMatchObject({ width: 640, height: 360, durationMs: null });
    expect(videoProbe.calls[0]!.format).toBe('webm');
  });

  it('leaves the row unchanged when the video probe yields nothing or fails', async () => {
    const { session, db, file, videoProbe } = await videoSetup();
    videoProbe.result = null;
    expect(await measureFile(session, file.id)).toEqual(file);
    videoProbe.failure = new Error('/secret/path broke');
    expect(await measureFile(session, file.id)).toEqual(file);
    expect(await db.files.get(file.id)).toMatchObject({ width: null, height: null, durationMs: null });
  });
});

describe('WorkspaceManager.measureFile', () => {
  async function managerSetup() {
    const fake = createFakeHost();
    const manager = new WorkspaceManager(fake.host);
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const db = fake.databases.get(summary.id)!;
    fake.sources.set('/src/clip.mp4', Buffer.from('video'));
    fake.videoProbe.result = { width: 1920, height: 1080, durationMs: 4500 };
    const file = (await manager.importFiles(['/src/clip.mp4']))[0]!.file!;
    let release!: () => void;
    fake.videoProbe.gate = new Promise<void>((resolve) => (release = resolve));
    const started = async () => {
      while (fake.videoProbe.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    };
    return { fake, manager, db, file, release, started };
  }

  it('probes outside the workspace queue and stores the result when the probe ends', async () => {
    const { manager, db, file, release, started } = await managerSetup();
    const measuring = manager.measureFile(file.id);
    await started();
    await expect(manager.exclusive(async () => 'done')).resolves.toBe('done');
    expect(await db.files.get(file.id)).toMatchObject({ width: null, height: null });
    release();
    await expect(measuring).resolves.toMatchObject({ id: file.id, width: 1920, height: 1080, durationMs: 4500 });
    expect(await db.files.get(file.id)).toMatchObject({ width: 1920, height: 1080, durationMs: 4500 });
  });

  it('writes nothing and answers the current record when the file was trashed meanwhile', async () => {
    const { manager, db, file, release, started } = await managerSetup();
    const measuring = manager.measureFile(file.id);
    await started();
    await manager.exclusive((s) => trashForTest(s, [file.id]));
    release();
    const answer = await measuring;
    expect(answer).toMatchObject({ id: file.id, width: null, height: null });
    expect(answer.deletedAt).not.toBeNull();
    expect(await db.files.get(file.id)).toMatchObject({ width: null, height: null });
  });

  it('writes nothing when the content or the measurement changed meanwhile', async () => {
    const { manager, db, file, release, started } = await managerSetup();
    const measuring = manager.measureFile(file.id);
    await started();
    db.files.records.set(file.id, { ...file, sha256: 'b'.repeat(64) });
    release();
    await expect(measuring).resolves.toMatchObject({ width: null, sha256: 'b'.repeat(64) });

    const other = await managerSetup();
    const second = other.manager.measureFile(other.file.id);
    await other.started();
    other.db.files.records.set(other.file.id, { ...other.file, width: 10, height: 20, durationMs: 30 });
    other.release();
    await expect(second).resolves.toMatchObject({ width: 10, height: 20, durationMs: 30 });
  });

  it('answers not_found and writes nothing when the file was purged meanwhile', async () => {
    const { manager, db, file, release, started } = await managerSetup();
    const measuring = manager.measureFile(file.id);
    await started();
    db.files.records.delete(file.id);
    release();
    await expect(measuring).rejects.toBeInstanceOf(NotFoundError);
    expect(db.files.records.has(file.id)).toBe(false);
  });

  it('writes nothing when the workspace was closed or switched meanwhile', async () => {
    const { manager, db, file, release, started } = await managerSetup();
    const measuring = manager.measureFile(file.id);
    await started();
    await manager.close();
    release();
    await expect(measuring).resolves.toMatchObject({ id: file.id, width: null });
    expect(await db.files.get(file.id)).toMatchObject({ width: null, height: null });

    const other = await managerSetup();
    const second = other.manager.measureFile(other.file.id);
    await other.started();
    await other.manager.create({ name: 'Other', rootPath: '/ws/b' });
    other.release();
    await expect(second).resolves.toMatchObject({ id: other.file.id, width: null });
    expect(await other.db.files.get(other.file.id)).toMatchObject({ width: null });
  });

  it('answers no_workspace_open without an open workspace', async () => {
    const manager = new WorkspaceManager(createFakeHost().host);
    await expect(manager.measureFile(UNKNOWN_ID)).rejects.toMatchObject({ code: 'no_workspace_open' });
  });
});

describe('measureFile of a trashed file', () => {
  it('measureFile still measures it', async () => {
    const { session, file, probe } = await setup();
    await trashForTest(session, [file.id]);
    await expect(measureFile(session, file.id)).resolves.toMatchObject({ width: 800, height: 600 });
    expect(probe.calls).toHaveLength(1);
  });
});
