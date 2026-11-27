import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FILE_DOWNLOAD_JOB } from '@assetforge/contracts';
import {
  clampRetryAfterMs,
  createAsset,
  enqueueUrlImport,
  importStream,
  listFileOrigins,
  normalizeDownloadUrl,
  resolveFileOriginUrl,
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  SourceNotReadableError,
  WorkspaceManager,
  type ImportContext,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, trashForTest } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const ctx: ImportContext = {
    storage: session.storage,
    storageId: session.storageId,
    files: db.files,
    sources: { open: () => Promise.reject(new SourceNotReadableError()) },
    probe: session.imageProbe,
    newId: () => session.newId(),
    now: () => session.now(),
  };
  /** A complete file downloaded from `url`. */
  const downloaded = async (url: string, data = url) => {
    const result = await importStream(
      ctx,
      { sourcePath: '', entryName: null, name: 'a.png', stream: Readable.from([Buffer.from(data)]) },
      { origin: { id: session.newId(), url } },
    );
    return result.file!;
  };
  return { fake, manager, db, session, downloaded };
}

describe('normalizeDownloadUrl', () => {
  it('drops the fragment', () => {
    expect(normalizeDownloadUrl('https://a.example/x.png#frag')).toBe('https://a.example/x.png');
    expect(normalizeDownloadUrl('  https://A.example/x.png#  ')).toBe('https://a.example/x.png');
    expect(normalizeDownloadUrl('http://a.example:8080/x?y=1')).toBe('http://a.example:8080/x?y=1');
  });

  it('refuses what the source rule refuses', () => {
    expect(() => normalizeDownloadUrl('ftp://a.example/x.png')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(() => normalizeDownloadUrl('https://user:pw@a.example/x.png')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(() => normalizeDownloadUrl(`https://a.example/${'x'.repeat(1983)}`)).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(() => normalizeDownloadUrl('nope')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
  });

  it('accepts exactly 2000 characters', () => {
    const url = `https://a.example/${'x'.repeat(1982)}`;
    expect(url.length).toBe(2000);
    expect(normalizeDownloadUrl(url)).toBe(url);
  });
});

describe('clampRetryAfterMs', () => {
  it('clamps to 5 s – 15 min and defaults to 60 s', () => {
    expect(clampRetryAfterMs(null)).toBe(RETRY_AFTER_DEFAULT_MS);
    expect(clampRetryAfterMs(Number.NaN)).toBe(RETRY_AFTER_DEFAULT_MS);
    expect(clampRetryAfterMs(0)).toBe(RETRY_AFTER_MIN_MS);
    expect(clampRetryAfterMs(90_000)).toBe(90_000);
    expect(clampRetryAfterMs(10 ** 9)).toBe(RETRY_AFTER_MAX_MS);
  });
});

describe('enqueueUrlImport', () => {
  const LINES = ['https://a.example/1.png', '', 'nope', 'https://a.example/1.png#x', 'https://b.example/2.png'];

  it('counts what it queues, what is already there and what is unusable', async () => {
    const { db, session, downloaded } = await setup();
    const known = await downloaded('https://b.example/2.png');
    await trashForTest(session, [known.id]);

    const result = await enqueueUrlImport(session, { urls: LINES, target: null, skipDuplicates: true });

    expect(result).toEqual({ queued: 1, alreadyImported: 1, alreadyQueued: 1, invalid: [{ line: 3, text: 'nope' }] });
    const jobs = db.jobs.rows.filter((j) => j.type === FILE_DOWNLOAD_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      resourceClass: 'io',
      lane: 'a.example',
      fileId: null,
      status: 'queued',
      dedupeKey: 'url:https://a.example/1.png',
      payload: { v: 1, url: 'https://a.example/1.png', target: null, skipDuplicates: true },
    });
  });

  it('with a site writes payload v2 with the profile and the filter, the site as lane and the same dedupe key', async () => {
    const { db, session } = await setup();
    const site = {
      profileId: '11111111-1111-4111-8111-111111111111',
      site: 'gallery.example',
      filter: { kinds: ['image' as const], minBytes: 100 },
    };
    const urls = ['https://a.example/1.png', 'https://img2.gallery.example/2.png'];
    const result = await enqueueUrlImport(session, { urls, target: null, skipDuplicates: true, site });
    expect(result.queued).toBe(2);
    expect(db.jobs.rows.map((job) => job.lane)).toEqual(['gallery.example', 'gallery.example']);
    expect(db.jobs.rows[0]).toMatchObject({
      lane: 'gallery.example',
      dedupeKey: 'url:https://a.example/1.png',
      payload: {
        v: 2,
        url: 'https://a.example/1.png',
        target: null,
        skipDuplicates: true,
        siteProfileId: site.profileId,
        filter: { kinds: ['image'], minBytes: 100 },
      },
    });
  });

  it('a second identical call queues nothing', async () => {
    const { session, downloaded } = await setup();
    await downloaded('https://b.example/2.png');
    await enqueueUrlImport(session, { urls: LINES, target: null, skipDuplicates: true });
    const again = await enqueueUrlImport(session, { urls: LINES, target: null, skipDuplicates: true });
    expect(again).toMatchObject({ queued: 0, alreadyImported: 1, alreadyQueued: 2 });
  });

  it('keeps a non-default port in the lane and stores the target', async () => {
    const { db, session } = await setup();
    const types = await db.assetTypes.list();
    const asset = await createAsset(session, { name: 'A', typeId: types[0]!.id });
    const target = { assetId: asset.id, role: 'reference' as const };
    await enqueueUrlImport(session, { urls: ['http://A.example:8080/x.png'], target, skipDuplicates: false });
    expect(db.jobs.rows[0]).toMatchObject({ lane: 'a.example:8080', payload: { url: 'http://a.example:8080/x.png', target, skipDuplicates: false } });
  });

  it('reports a line over 2000 characters and cuts its text to 200', async () => {
    const { session } = await setup();
    const long = `https://a.example/${'x'.repeat(1990)}`;
    const result = await enqueueUrlImport(session, { urls: [long, 'ftp://a.example/x'], target: null, skipDuplicates: true });
    expect(result.queued).toBe(0);
    expect(result.invalid).toEqual([
      { line: 1, text: long.slice(0, 200) },
      { line: 2, text: 'ftp://a.example/x' },
    ]);
  });

  it('measures a line after the trim, so trailing spaces never make it too long', async () => {
    const { db, session } = await setup();
    const url = `https://a.example/${'x'.repeat(1995 - 'https://a.example/'.length)}`;
    expect(url.length).toBe(1995);
    const result = await enqueueUrlImport(session, { urls: [`${url}          `], target: null, skipDuplicates: true });
    expect(result).toEqual({ queued: 1, alreadyImported: 0, alreadyQueued: 0, invalid: [] });
    expect(db.jobs.rows[0]).toMatchObject({ payload: { url } });
  });

  it('an unknown target asset answers not_found and queues nothing', async () => {
    const { db, session } = await setup();
    await expect(
      enqueueUrlImport(session, { urls: ['https://a.example/1.png'], target: { assetId: UNKNOWN, role: 'reference' }, skipDuplicates: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(db.jobs.rows).toEqual([]);
  });

  it('only blank lines queue nothing and call no enqueue', async () => {
    const { db, session } = await setup();
    const result = await enqueueUrlImport(session, { urls: ['', '   '], target: null, skipDuplicates: true });
    expect(result).toEqual({ queued: 0, alreadyImported: 0, alreadyQueued: 0, invalid: [] });
    expect(db.jobs.rows).toEqual([]);
  });
});

describe('file origins', () => {
  it('lists the origins of a file and answers not_found for an unknown file', async () => {
    const { session, downloaded } = await setup();
    const file = await downloaded('https://a.example/1.png');
    await expect(listFileOrigins(session, file.id)).resolves.toEqual([
      { id: expect.any(String), url: 'https://a.example/1.png', createdAt: file.importedAt },
    ]);
    await expect(listFileOrigins(session, UNKNOWN)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resolves the stored URL of an origin of the file', async () => {
    const { session, downloaded } = await setup();
    const file = await downloaded('https://a.example/1.png');
    const [origin] = await listFileOrigins(session, file.id);
    await expect(resolveFileOriginUrl(session, { fileId: file.id, originId: origin!.id })).resolves.toBe('https://a.example/1.png');
  });

  it('answers not_found for an unknown origin or one of another file', async () => {
    const { session, downloaded } = await setup();
    const a = await downloaded('https://a.example/1.png');
    const b = await downloaded('https://a.example/2.png');
    const [origin] = await listFileOrigins(session, a.id);
    await expect(resolveFileOriginUrl(session, { fileId: b.id, originId: origin!.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveFileOriginUrl(session, { fileId: a.id, originId: UNKNOWN })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies the URL rule again to a stored URL', async () => {
    const { db, session, downloaded } = await setup();
    const file = await downloaded('https://a.example/1.png');
    const [origin] = await listFileOrigins(session, file.id);
    db.fileOrigins.rows.get(origin!.id)!.url = 'javascript:alert(1)';
    await expect(resolveFileOriginUrl(session, { fileId: file.id, originId: origin!.id })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
