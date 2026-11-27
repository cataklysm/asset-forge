import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FILE_DOWNLOAD_JOB, type FileTarget } from '@assetforge/contracts';
import {
  createAsset,
  createFileDownloadHandler,
  DOWNLOAD_FREE_SPACE_RESERVE,
  JobError,
  RemoteFileError,
  STAGING_DIR,
  WorkspaceManager,
  type Job,
  type RemoteFile,
  type RemoteFileSource,
  type RemoteOpenOptions,
  type SiteAccess,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';

type Answer = {
  body?: Buffer;
  stream?: (signal: AbortSignal) => Readable;
  contentType?: string | null;
  contentLength?: number | null;
  finalUrl?: string;
  dispositionName?: string | null;
};

/** Serves buffers by URL; an entry may be a failure to reject with. Records every URL opened and every stream destroyed. */
class FakeRemote implements RemoteFileSource {
  readonly opened: string[] = [];
  readonly options: (RemoteOpenOptions | undefined)[] = [];
  readonly streams: Readable[] = [];
  readonly answers = new Map<string, Answer | Error>();
  /** The hops of a URL, asked through `headersFor` in this order before the answer, as the adapter does per hop. */
  readonly hops = new Map<string, string[]>();

  async open(url: string, signal: AbortSignal, options?: RemoteOpenOptions): Promise<RemoteFile> {
    this.opened.push(url);
    this.options.push(options);
    for (const hop of this.hops.get(url) ?? [url]) await options?.headersFor?.(hop);
    const answer = this.answers.get(url);
    if (answer === undefined) throw new RemoteFileError('not_found');
    if (answer instanceof Error) throw answer;
    const stream = answer.stream?.(signal) ?? Readable.from([answer.body ?? Buffer.from(url)]);
    this.streams.push(stream);
    return {
      stream,
      finalUrl: answer.finalUrl ?? url,
      contentType: answer.contentType === undefined ? 'image/png' : answer.contentType,
      contentLength: answer.contentLength ?? null,
      dispositionName: answer.dispositionName ?? null,
    };
  }
}

async function setup(o: { sites?: SiteAccess } = {}) {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const storage = fake.storages.get(ROOT)!;
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  fake.host.now = () => new Date((clock += 1000));
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const remote = new FakeRemote();
  /** What the handler reported through its effects; `throwing` makes every report throw. */
  const effects = { changed: [] as string[], added: [] as (string | null)[], throwing: false };
  const handler = createFileDownloadHandler({
    session,
    remote,
    ...(o.sites === undefined ? {} : { sites: o.sites }),
    effects: {
      fileChanged: (id) => {
        effects.changed.push(id);
        if (effects.throwing) throw new Error('listener failed');
      },
      fileAdded: (assetId) => {
        effects.added.push(assetId);
        if (effects.throwing) throw new Error('listener failed');
      },
    },
  });
  const now = () => session.now().toISOString();

  /** Queues a download job and claims it, so it is running. */
  const claim = async (url: string, o: { target?: FileTarget | null; skipDuplicates?: boolean; payload?: unknown } = {}) => {
    await db.jobs.enqueue({
      jobs: [
        {
          id: session.newId(),
          type: FILE_DOWNLOAD_JOB,
          resourceClass: 'io',
          fileId: null,
          lane: new URL(url).host,
          payload: o.payload ?? { v: 1, url, target: o.target ?? null, skipDuplicates: o.skipDuplicates ?? true },
          dedupeKey: `url:${url}`,
        },
      ],
      now: now(),
    });
    return (await db.jobs.claimNext({ resourceClass: 'io', types: [FILE_DOWNLOAD_JOB], now: now() }))!;
  };
  /** Runs the job; answers the run's error or null. */
  const run = async (job: Job, signal = new AbortController().signal) =>
    handler.run(job, signal).then(
      () => null,
      (e: unknown) => e,
    );
  /** Claims, runs and ends the job like the scheduler, so a later job with the same URL can be queued. */
  const download = async (url: string, o: Parameters<typeof claim>[1] = {}) => {
    const job = await claim(url, o);
    const error = await run(job);
    await db.jobs.finish(job.id, { status: error === null ? 'succeeded' : 'failed', errorCode: error === null ? null : 'internal_error', now: now() });
    return { job, error };
  };
  const jobRow = (id: string) => db.jobs.rows.find((j) => j.id === id)!;
  const files = () => [...db.files.records.values()];
  const staged = () => [...storage.files.keys()].filter((k) => k.startsWith(`${STAGING_DIR}/`));
  const newAsset = async (name: string) => {
    const types = await db.assetTypes.list();
    return (await createAsset(session, { name, typeId: types[0]!.id })).id;
  };
  return { fake, db, storage, session, remote, handler, claim, run, download, jobRow, files, staged, newAsset, effects };
}

const codeOf = (error: unknown) => (error instanceof JobError ? error.code : error);

/** A stream that yields one chunk and then fails with `error`. */
const failingAfterChunk = (error: Error) => () =>
  new Readable({
    read() {
      this.push(Buffer.from('partial'));
      this.destroy(error);
    },
  });

describe('createFileDownloadHandler', () => {
  it('is an io handler that is requeued when interrupted', async () => {
    const { handler } = await setup();
    expect(handler.resourceClass).toBe('io');
    expect(handler.onInterrupted).toBe('requeue');
  });

  it('stores the downloaded file with its origin and points the job at it', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', { body: Buffer.from('png') });
    const { job, error } = await t.download('https://a.example/x.png');

    expect(error).toBeNull();
    const [file] = t.files();
    expect(file).toMatchObject({ status: 'complete', originalName: 'x.png', assetId: null, sizeBytes: 3 });
    expect(t.jobRow(job.id).fileId).toBe(file!.id);
    expect(t.db.jobs.results.has(job.id)).toBe(false);
    await expect(t.db.fileOrigins.listByFile(file!.id)).resolves.toEqual([
      { id: expect.any(String), url: 'https://a.example/x.png', createdAt: file!.importedAt },
    ]);
  });

  it('names the file after the final URL but stores the requested URL as origin', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/go', { finalUrl: 'https://cdn.example/real.png?sig=1', contentType: 'image/png' });
    await t.download('https://a.example/go');
    const [file] = t.files();
    expect(file!.originalName).toBe('real.png');
    expect((await t.db.fileOrigins.listByFile(file!.id))[0]!.url).toBe('https://a.example/go');
  });

  it('moves the file into the target asset with the role', async () => {
    const t = await setup();
    const assetId = await t.newAsset('A');
    t.remote.answers.set('https://a.example/x.png', {});
    const { error } = await t.download('https://a.example/x.png', { target: { assetId, role: 'concept' } });
    expect(error).toBeNull();
    expect(t.files()[0]).toMatchObject({ assetId, role: 'concept', status: 'complete' });
  });

  it('leaves the file in the inbox and succeeds when the target asset is gone', async () => {
    const t = await setup();
    const assetId = await t.newAsset('A');
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png', { target: { assetId, role: 'concept' } });
    t.db.assets.rows.delete(assetId);
    expect(await t.run(job)).toBeNull();
    expect(t.files()[0]).toMatchObject({ assetId: null, role: null, status: 'complete' });
    expect(t.jobRow(job.id).fileId).toBe(t.files()[0]!.id);
  });

  it('with skipDuplicates a known content adds the URL to the existing file', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('same') });
    t.remote.answers.set('https://b.example/2.png', { body: Buffer.from('same') });
    await t.download('https://a.example/1.png');
    const { job, error } = await t.download('https://b.example/2.png', { skipDuplicates: true });

    expect(error).toBeNull();
    expect(t.files()).toHaveLength(1);
    const file = t.files()[0]!;
    expect((await t.db.fileOrigins.listByFile(file.id)).map((o) => o.url)).toEqual(['https://a.example/1.png', 'https://b.example/2.png']);
    expect(t.jobRow(job.id).fileId).toBe(file.id);
    expect(t.db.jobs.results.get(job.id)).toBe('already_present');
    expect(t.staged()).toEqual([]);
    // The discarded pending row took its origin with it; only the two of the kept file remain.
    expect(t.db.fileOrigins.rows.size).toBe(2);
  });

  it('with skipDuplicates never moves the existing file into the target', async () => {
    const t = await setup();
    const assetId = await t.newAsset('A');
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('same') });
    t.remote.answers.set('https://b.example/2.png', { body: Buffer.from('same') });
    await t.download('https://a.example/1.png');
    await t.download('https://b.example/2.png', { target: { assetId, role: 'concept' } });
    expect(t.files()[0]).toMatchObject({ assetId: null });
  });

  it('without skipDuplicates a known content is stored again', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('same') });
    t.remote.answers.set('https://b.example/2.png', { body: Buffer.from('same') });
    await t.download('https://a.example/1.png');
    const { job } = await t.download('https://b.example/2.png', { skipDuplicates: false });
    expect(t.files()).toHaveLength(2);
    expect(t.db.jobs.results.has(job.id)).toBe(false);
  });

  it('a URL that a complete file already carries is not fetched again', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/1.png', {});
    await t.download('https://a.example/1.png');
    const { job, error } = await t.download('https://a.example/1.png');
    expect(error).toBeNull();
    expect(t.remote.opened).toEqual(['https://a.example/1.png']);
    expect(t.db.jobs.results.get(job.id)).toBe('already_present');
    expect(t.jobRow(job.id).fileId).toBe(t.files()[0]!.id);
  });

  it('refuses a web page and leaves no file row', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/gallery', { contentType: 'text/html' });
    const { error } = await t.download('https://a.example/gallery');
    expect(codeOf(error)).toBe('download_not_a_file');
    expect(t.files()).toEqual([]);
    expect(t.remote.streams[0]!.destroyed).toBe(true);
  });

  it('refuses a type the import refuses', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/evil.exe', { contentType: 'application/octet-stream' });
    const { error } = await t.download('https://a.example/evil.exe');
    expect(codeOf(error)).toBe('download_type_refused');
    expect(t.files()).toEqual([]);
    expect(t.remote.streams[0]!.destroyed).toBe(true);
  });

  it('refuses a refused name that a content-type extension would disguise', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x', { dispositionName: 'evil.exe', contentType: 'image/png' });
    const { error } = await t.download('https://a.example/x');
    expect(codeOf(error)).toBe('download_type_refused');
    expect(t.files()).toEqual([]);
    expect(t.remote.streams[0]!.destroyed).toBe(true);
  });

  it('only a throttled failure carries a wait', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', new RemoteFileError('unavailable', 90_000));
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toMatchObject({ code: 'download_unavailable', retryAfterMs: null });
  });

  it('a stream that fails while the free space is checked maps the failure and leaves nothing behind', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', { contentLength: 10 });
    let calls = 0;
    t.storage.freeBytes = async () => {
      if (++calls === 2) {
        t.remote.streams[0]!.destroy(new RemoteFileError('unreachable'));
        await new Promise((resolve) => setImmediate(resolve));
      }
      return null;
    };
    const { error } = await t.download('https://a.example/x.png');
    expect(codeOf(error)).toBe('download_unreachable');
    expect(t.files()).toEqual([]);
    expect(t.db.fileOrigins.rows.size).toBe(0);
    expect(t.staged()).toEqual([]);
  });

  it('an abort while the free space is checked rejects with the abort', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', {
      stream: (signal) => {
        const stream = Readable.from([Buffer.from('x')]);
        signal.addEventListener('abort', () => stream.destroy(signal.reason as Error), { once: true });
        return stream;
      },
    });
    const controller = new AbortController();
    let calls = 0;
    t.storage.freeBytes = async () => {
      if (++calls === 2) {
        controller.abort();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return null;
    };
    const job = await t.claim('https://a.example/x.png');
    const error = await t.run(job, controller.signal);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(t.files()).toEqual([]);
    expect(t.staged()).toEqual([]);
  });

  it('maps a failure of the source to its code and carries the wait', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', new RemoteFileError('throttled', 90_000));
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'download_throttled', retryAfterMs: 90_000 });
  });

  it('maps every failure kind', async () => {
    const t = await setup();
    const kinds = ['unreachable', 'unavailable', 'blocked', 'not_found', 'rejected', 'address_refused', 'too_large'] as const;
    for (const kind of kinds) {
      const url = `https://a.example/${kind}.png`;
      t.remote.answers.set(url, new RemoteFileError(kind));
      const { error } = await t.download(url);
      expect(error).toMatchObject({ code: `download_${kind}`, retryAfterMs: null });
    }
  });

  it('gives a throttled failure without a wait the default wait', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', new RemoteFileError('throttled'));
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toMatchObject({ code: 'download_throttled', retryAfterMs: 60_000 });
  });

  it('a stream that fails mid-body with too_large leaves no row and no staged bytes', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', { stream: failingAfterChunk(new RemoteFileError('too_large')) });
    const { error } = await t.download('https://a.example/x.png');
    expect(codeOf(error)).toBe('download_too_large');
    expect(t.files()).toEqual([]);
    expect(t.db.fileOrigins.rows.size).toBe(0);
    expect(t.staged()).toEqual([]);
  });

  it('a stream that fails mid-body with another error is internal_error', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', { stream: failingAfterChunk(new Error('boom https://a.example/x.png')) });
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toBeInstanceOf(JobError);
    expect(codeOf(error)).toBe('internal_error');
    expect((error as Error).message).not.toContain('a.example');
    expect(t.files()).toEqual([]);
  });

  it('an unexpected failure to open is internal_error without the URL', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', new TypeError('Invalid URL https://a.example/x.png'));
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toBeInstanceOf(JobError);
    expect(codeOf(error)).toBe('internal_error');
    expect((error as Error).message).not.toContain('a.example');
    expect((error as Error).cause).toBeUndefined();
  });

  it('refuses without a request when the free space is below the reserve', async () => {
    const t = await setup();
    t.storage.free = 1024 ** 3;
    t.remote.answers.set('https://a.example/x.png', {});
    const { error } = await t.download('https://a.example/x.png');
    expect(codeOf(error)).toBe('download_no_space');
    expect(t.remote.opened).toEqual([]);
  });

  it('refuses at exactly the reserve, since the free space must exceed it', async () => {
    const t = await setup();
    t.storage.free = DOWNLOAD_FREE_SPACE_RESERVE;
    t.remote.answers.set('https://a.example/x.png', {});
    const { error } = await t.download('https://a.example/x.png');
    expect(codeOf(error)).toBe('download_no_space');
    expect(t.remote.opened).toEqual([]);
  });

  it('refuses after the headers when the announced length does not fit', async () => {
    const t = await setup();
    t.storage.free = DOWNLOAD_FREE_SPACE_RESERVE + 100;
    t.remote.answers.set('https://a.example/x.png', { contentLength: 100 });
    t.remote.answers.set('https://a.example/y.png', { contentLength: 99 });
    const x = await t.download('https://a.example/x.png');
    expect(codeOf(x.error)).toBe('download_no_space');
    expect(t.remote.streams[0]!.destroyed).toBe(true);
    expect(t.files()).toEqual([]);
    const y = await t.download('https://a.example/y.png');
    expect(y.error).toBeNull();
  });

  it('downloads when the storage cannot report its free space', async () => {
    const t = await setup();
    t.storage.free = null;
    t.remote.answers.set('https://a.example/x.png', { contentLength: 10 ** 12 });
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toBeNull();
  });

  it('an invalid payload is internal_error', async () => {
    const t = await setup();
    const job = await t.claim('https://a.example/x.png', { payload: { v: 2 } });
    expect(codeOf(await t.run(job))).toBe('internal_error');
    expect(t.remote.opened).toEqual([]);
  });

  it('an abort mid-body rejects and leaves no row and no staged bytes', async () => {
    const t = await setup();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    t.remote.answers.set('https://a.example/x.png', {
      stream: (signal) => {
        let sent = false;
        const stream = new Readable({
          read() {
            if (this.readableLength === 0 && !sent) {
              sent = true;
              this.push(Buffer.from('partial'));
              started();
            }
          },
        });
        signal.addEventListener('abort', () => stream.destroy(signal.reason as Error), { once: true });
        return stream;
      },
    });
    const job = await t.claim('https://a.example/x.png');
    const controller = new AbortController();
    const running = t.run(job, controller.signal);
    await reading;
    controller.abort();
    const error = await running;

    expect(error).toMatchObject({ name: 'AbortError' });
    expect(t.files()).toEqual([]);
    expect(t.db.fileOrigins.rows.size).toBe(0);
    expect(t.staged()).toEqual([]);
  });

  it('an abort before the request rejects without opening', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png');
    const controller = new AbortController();
    controller.abort();
    const error = await t.run(job, controller.signal);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(t.files()).toEqual([]);
  });

  it('does not throw when the job is no longer running at the end', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png');
    await t.db.jobs.finish(job.id, { status: 'cancelled', errorCode: null, now: t.session.now().toISOString() });
    expect(await t.run(job)).toBeNull();
    expect(t.files()).toHaveLength(1);
  });
});

describe('the effects of the download handler', () => {
  it('reports the inbox for a file without a target, and the asset and the inbox it passed for one placed in it', async () => {
    const t = await setup();
    const assetId = await t.newAsset('A');
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('one') });
    t.remote.answers.set('https://a.example/2.png', { body: Buffer.from('two') });
    await t.download('https://a.example/1.png');
    await t.download('https://a.example/2.png', { target: { assetId, role: 'concept' } });
    expect(t.effects.added).toEqual([null, assetId, null]);
    expect(t.effects.changed).toEqual([]);
  });

  it('reports the inbox when the target asset is gone', async () => {
    const t = await setup();
    const assetId = await t.newAsset('A');
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png', { target: { assetId, role: 'concept' } });
    t.db.assets.rows.delete(assetId);
    expect(await t.run(job)).toBeNull();
    expect(t.effects.added).toEqual([null]);
  });

  it('reports nothing for an already present file or a failure', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('same') });
    t.remote.answers.set('https://b.example/2.png', { body: Buffer.from('same') });
    t.remote.answers.set('https://c.example/page', { contentType: 'text/html' });
    await t.download('https://a.example/1.png');
    t.effects.added.length = 0;
    await t.download('https://b.example/2.png', { skipDuplicates: true });
    await t.download('https://a.example/1.png');
    const { error } = await t.download('https://c.example/page');
    expect(codeOf(error)).toBe('download_not_a_file');
    expect(t.effects.added).toEqual([]);
  });

  it('still succeeds when the report throws', async () => {
    const t = await setup();
    t.effects.throwing = true;
    t.remote.answers.set('https://a.example/x.png', {});
    const { error } = await t.download('https://a.example/x.png');
    expect(error).toBeNull();
    expect(t.effects.added).toEqual([null]);
  });
});

describe('site downloads (payload v2)', () => {
  const PROFILE = '11111111-1111-4111-8111-111111111111';
  const sitePayload = (url: string, filter: { kinds: string[]; minBytes: number }, siteProfileId = PROFILE) => ({
    v: 2,
    url,
    target: null,
    skipDuplicates: true,
    siteProfileId,
    filter,
  });

  /** A site access that knows PROFILE on the site https://a.example and records every question. */
  function fakeSites(known = true) {
    const has: string[] = [];
    const asked: [string, string][] = [];
    const sites: SiteAccess = {
      siteOf: async (id) => {
        has.push(id);
        return known && id === PROFILE ? 'a.example' : null;
      },
      headersFor: async (id, url) => {
        asked.push([id, url]);
        return url.startsWith('https://a.example/') ? { cookie: 'sid=1' } : null;
      },
    };
    return { sites, has, asked };
  }

  it('fails download_profile_missing when the profile is unknown, without opening', async () => {
    const f = fakeSites(false);
    const t = await setup({ sites: f.sites });
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png', { payload: sitePayload('https://a.example/x.png', { kinds: ['image'], minBytes: 0 }) });
    expect(codeOf(await t.run(job))).toBe('download_profile_missing');
    expect(f.has).toEqual([PROFILE]);
    expect(t.remote.opened).toEqual([]);
    expect(t.files()).toEqual([]);
  });

  it('fails download_profile_missing when no site access is wired', async () => {
    const t = await setup();
    t.remote.answers.set('https://a.example/x.png', {});
    const job = await t.claim('https://a.example/x.png', { payload: sitePayload('https://a.example/x.png', { kinds: ['image'], minBytes: 0 }) });
    expect(codeOf(await t.run(job))).toBe('download_profile_missing');
    expect(t.remote.opened).toEqual([]);
  });

  it('passes headersFor bound to its profile and stores the file', async () => {
    const f = fakeSites();
    const t = await setup({ sites: f.sites });
    t.remote.answers.set('https://a.example/x.png', { body: Buffer.from('png') });
    const job = await t.claim('https://a.example/x.png', { payload: sitePayload('https://a.example/x.png', { kinds: ['image'], minBytes: 0 }) });
    expect(await t.run(job)).toBeNull();
    const headersFor = t.remote.options[0]?.headersFor;
    expect(headersFor).toBeTypeOf('function');
    await expect(headersFor!('https://a.example/hop')).resolves.toEqual({ cookie: 'sid=1' });
    expect(f.asked).toEqual([
      [PROFILE, 'https://a.example/x.png'],
      [PROFILE, 'https://a.example/hop'],
    ]);
    expect(t.files()).toHaveLength(1);
    expect(t.jobRow(job.id).fileId).toBe(t.files()[0]!.id);
  });

  it('a v1 job never asks the site access and opens without options', async () => {
    const f = fakeSites();
    const t = await setup({ sites: f.sites });
    t.remote.answers.set('https://a.example/x.png', {});
    expect((await t.download('https://a.example/x.png')).error).toBeNull();
    expect(f.has).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(t.remote.options).toEqual([undefined]);
  });

  it('an announced length below minBytes ends filtered before anything is stored', async () => {
    const t = await setup({ sites: fakeSites().sites });
    const before = [...t.storage.files.keys()];
    t.remote.answers.set('https://a.example/x.png', { body: Buffer.from('png'), contentLength: 3 });
    const job = await t.claim('https://a.example/x.png', { payload: sitePayload('https://a.example/x.png', { kinds: ['image'], minBytes: 4 }) });
    expect(await t.run(job)).toBeNull();
    expect(t.db.jobs.results.get(job.id)).toBe('filtered_size');
    expect(t.jobRow(job.id).fileId).toBeNull();
    expect(t.files()).toEqual([]);
    expect(t.remote.streams[0]!.destroyed).toBe(true);
    expect([...t.storage.files.keys()]).toEqual(before);
    expect(t.db.fileOrigins.rows.size).toBe(0);
    expect(t.effects.added).toEqual([]);
  });

  it('a final name whose kind is not wanted ends filtered before anything is stored', async () => {
    const t = await setup({ sites: fakeSites().sites });
    t.remote.answers.set('https://a.example/go', { finalUrl: 'https://a.example/clip.mp4', contentType: 'video/mp4' });
    const job = await t.claim('https://a.example/go', { payload: sitePayload('https://a.example/go', { kinds: ['image'], minBytes: 0 }) });
    expect(await t.run(job)).toBeNull();
    expect(t.db.jobs.results.get(job.id)).toBe('filtered_kind');
    expect(t.jobRow(job.id).fileId).toBeNull();
    expect(t.files()).toEqual([]);
    expect(t.remote.streams[0]!.destroyed).toBe(true);
  });

  it('a wanted kind with an announced length at minBytes is stored', async () => {
    const t = await setup({ sites: fakeSites().sites });
    t.remote.answers.set('https://a.example/clip.mp4', { body: Buffer.from('mp4!'), contentLength: 4, contentType: 'video/mp4' });
    const job = await t.claim('https://a.example/clip.mp4', {
      payload: sitePayload('https://a.example/clip.mp4', { kinds: ['image', 'video'], minBytes: 4 }),
    });
    expect(await t.run(job)).toBeNull();
    expect(t.files()).toMatchObject([{ kind: 'video', status: 'complete' }]);
    expect(t.db.jobs.results.has(job.id)).toBe(false);
  });

  it('an unknown length below minBytes is discarded after staging', async () => {
    const t = await setup({ sites: fakeSites().sites });
    const before = [...t.storage.files.keys()];
    t.remote.answers.set('https://a.example/x.png', { body: Buffer.from('png'), contentLength: null });
    const job = await t.claim('https://a.example/x.png', { payload: sitePayload('https://a.example/x.png', { kinds: ['image'], minBytes: 4 }) });
    expect(await t.run(job)).toBeNull();
    expect(t.db.jobs.results.get(job.id)).toBe('filtered_size');
    expect(t.jobRow(job.id).fileId).toBeNull();
    expect(t.files()).toEqual([]);
    expect(t.staged()).toEqual([]);
    expect([...t.storage.files.keys()]).toEqual(before);
    expect(t.db.fileOrigins.rows.size).toBe(0);
    expect(t.effects.added).toEqual([]);
  });

  it('a small duplicate of a known file is filtered, not added as an origin', async () => {
    const t = await setup({ sites: fakeSites().sites });
    t.remote.answers.set('https://a.example/1.png', { body: Buffer.from('png') });
    t.remote.answers.set('https://a.example/2.png', { body: Buffer.from('png') });
    await t.download('https://a.example/1.png');
    const job = await t.claim('https://a.example/2.png', { payload: sitePayload('https://a.example/2.png', { kinds: ['image'], minBytes: 4 }) });
    expect(await t.run(job)).toBeNull();
    expect(t.db.jobs.results.get(job.id)).toBe('filtered_size');
    expect(t.db.fileOrigins.rows.size).toBe(1);
  });

  it('a wrong kind wins over a small announced length', async () => {
    const t = await setup({ sites: fakeSites().sites });
    t.remote.answers.set('https://a.example/clip.mp4', { contentLength: 1, contentType: 'video/mp4' });
    const job = await t.claim('https://a.example/clip.mp4', {
      payload: sitePayload('https://a.example/clip.mp4', { kinds: ['image'], minBytes: 4 }),
    });
    expect(await t.run(job)).toBeNull();
    expect(t.db.jobs.results.get(job.id)).toBe('filtered_kind');
  });

  it('a refusal after a hop off the site is download_login_not_sent', async () => {
    const t = await setup({ sites: fakeSites().sites });
    const url = 'https://a.example/x.png';
    t.remote.hops.set(url, [url, 'https://cdn.other.example/x.png']);
    t.remote.answers.set(url, new RemoteFileError('blocked'));
    const job = await t.claim(url, { payload: sitePayload(url, { kinds: ['image'], minBytes: 0 }) });
    const error = await t.run(job);
    expect(codeOf(error)).toBe('download_login_not_sent');
    expect((error as JobError).message).not.toContain('example');
    expect(t.files()).toEqual([]);
  });

  it('a refusal on the site itself stays download_blocked', async () => {
    const t = await setup({ sites: fakeSites().sites });
    const url = 'https://a.example/x.png';
    t.remote.hops.set(url, ['https://cdn.other.example/go', url]);
    t.remote.answers.set(url, new RemoteFileError('blocked'));
    const job = await t.claim(url, { payload: sitePayload(url, { kinds: ['image'], minBytes: 0 }) });
    expect(codeOf(await t.run(job))).toBe('download_blocked');
  });

  it('a refusal on the site stays download_blocked when the profile is deleted during the download', async () => {
    const f = fakeSites();
    const url = 'https://a.example/x.png';
    const sites: SiteAccess = {
      siteOf: f.sites.siteOf,
      headersFor: async () => null,
    };
    const t = await setup({ sites });
    t.remote.hops.set(url, [url]);
    t.remote.answers.set(url, new RemoteFileError('blocked'));
    const job = await t.claim(url, { payload: sitePayload(url, { kinds: ['image'], minBytes: 0 }) });
    expect(codeOf(await t.run(job))).toBe('download_blocked');
  });

  it('another failure after a hop off the site keeps its code', async () => {
    const t = await setup({ sites: fakeSites().sites });
    const url = 'https://a.example/x.png';
    t.remote.hops.set(url, [url, 'https://cdn.other.example/x.png']);
    t.remote.answers.set(url, new RemoteFileError('not_found'));
    const job = await t.claim(url, { payload: sitePayload(url, { kinds: ['image'], minBytes: 0 }) });
    expect(codeOf(await t.run(job))).toBe('download_not_found');
  });

  it('a v1 job refused off any site stays download_blocked', async () => {
    const t = await setup({ sites: fakeSites().sites });
    t.remote.answers.set('https://cdn.other.example/x.png', new RemoteFileError('blocked'));
    expect(codeOf((await t.download('https://cdn.other.example/x.png')).error)).toBe('download_blocked');
  });
});
