import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SaveSiteProfile } from '@assetforge/contracts';
import { RemoteFileError, type PageLoader, type PageLoadResult, type RemoteFileSource } from '@assetforge/core';
import type { SiteSessions } from '../src/main/site-sessions.js';
import { siteLaneLimit } from '../src/main/lane-limits.js';
import { abortableWait } from '../src/main/abortable-wait.js';
import { createHarness, type Harness } from './analysis-harness.js';

// The `sites:*` channels as the app wires them, with the windows behind a fake SiteSessions: no window opens.

const GALLERY = 'https://example.com/gallery';

const profileRequest = (o: Partial<SaveSiteProfile> = {}): SaveSiteProfile => ({
  url: GALLERY,
  name: 'Example',
  thumbnails: '//a',
  pagination: '',
  file: '',
  kinds: ['image', 'video'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
  ...o,
});

/** Every robots.txt is missing; nothing else is ever fetched in these tests. */
const noRobots: RemoteFileSource = {
  open: async () => {
    throw new RemoteFileError('not_found');
  },
};

interface FakeSessions extends SiteSessions {
  login: string | null;
  opened: { profileId: string; url: string }[];
  focused: number;
  pages: number;
  closed: number;
  cleared: string[];
  loader: PageLoader;
  failClear: boolean;
  /** The `onGone` of the page window opened last. */
  gone: (() => void) | null;
}

function fakeSessions(): FakeSessions {
  const fake: FakeSessions = {
    login: null,
    opened: [],
    focused: 0,
    pages: 0,
    closed: 0,
    cleared: [],
    failClear: false,
    loader: {
      load: async (url): Promise<PageLoadResult> => ({
        ok: true,
        results: { thumbnails: ['/a.jpg', 'https://cdn.example.com/b.png'], pagination: [] },
        baseUrl: url,
        finalUrl: url,
      }),
    },
    openLogin(profile, url) {
      fake.login = profile.id;
      fake.opened.push({ profileId: profile.id, url });
    },
    loginProfileId: () => fake.login,
    focusLogin() {
      fake.focused++;
    },
    gone: null,
    openPage(_profile, onGone) {
      fake.pages++;
      fake.gone = onGone ?? null;
      return {
        loader: { load: (url, r) => fake.loader.load(url, r) },
        close: () => {
          fake.closed++;
        },
      };
    },
    cookies: async () => [],
    userAgent: () => 'Test agent',
    async clear(id) {
      fake.cleared.push(id);
      if (fake.failClear) throw new Error('clear failed');
    },
  };
  return fake;
}

/** A loader that waits until the crawl is cancelled. */
function blockingLoader(): PageLoader & { started: Promise<void> } {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  return {
    started: startedPromise,
    load: (_url, r) =>
      new Promise((resolve) => {
        started();
        r.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'failed' }), { once: true });
      }),
  };
}

describe('site handlers', () => {
  let h: Harness | undefined;
  let sessions: FakeSessions;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function harness(o: { workspace?: boolean; holdJobs?: boolean } = {}): Promise<Harness> {
    sessions = fakeSessions();
    h = await createHarness({
      remote: noRobots,
      siteSessions: sessions,
      siteWait: async () => {},
      ...(o.holdJobs === true ? { host: { workspaceOpened: async () => {} } } : {}),
    });
    if (o.workspace !== false) {
      const root = join(h.base, 'workspace');
      await mkdir(root, { recursive: true });
      await h.ok('workspace:create', { name: 'Test', rootPath: root });
    }
    return h;
  }

  const error = async (channel: Parameters<Harness['call']>[0], request: unknown) => {
    const result = await h!.call(channel, request);
    if (result.ok) throw new Error(`${channel} succeeded`);
    return result.error;
  };

  it('lists, saves and deletes profiles without a workspace', async () => {
    await harness({ workspace: false });
    const profile = await h!.ok('sites:save', profileRequest());
    expect(profile.site).toBe('example.com');
    expect((await h!.ok('sites:list', {})).profiles.map((p) => p.id)).toEqual([profile.id]);
    expect(await h!.ok('sites:delete', { id: profile.id })).toEqual({});
    expect((await h!.ok('sites:list', {})).profiles).toEqual([]);
    expect(sessions.cleared).toEqual([profile.id]);
    expect(await error('sites:delete', { id: profile.id })).toMatchObject({ code: 'not_found' });
  });

  it('keeps a deleted profile deleted when its session cannot be cleared, and logs only the id', async () => {
    await harness({ workspace: false });
    const profile = await h!.ok('sites:save', profileRequest());
    sessions.failClear = true;
    expect(await h!.ok('sites:delete', { id: profile.id })).toEqual({});
    expect((await h!.ok('sites:list', {})).profiles).toEqual([]);
    expect(h!.logs).toContain(`site profile ${profile.id}: session_clear_failed`);
  });

  it('opens one login window, focuses it again for its profile and refuses another', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    const b = await h!.ok('sites:save', profileRequest({ name: 'Other', url: 'https://other.example.org/' }));
    expect(await h!.ok('sites:openLogin', { profileId: a.id })).toEqual({});
    expect(sessions.opened).toEqual([{ profileId: a.id, url: 'https://example.com/' }]);
    expect(await h!.ok('sites:openLogin', { profileId: a.id, url: 'https://login.example.net/' })).toEqual({});
    expect(sessions.focused).toBe(1);
    expect(sessions.opened).toHaveLength(1);
    expect(await error('sites:openLogin', { profileId: b.id })).toEqual({
      code: 'invalid_operation',
      message: 'Another login window is open',
    });
    // The profile of the open window can be neither changed nor deleted.
    expect(await error('sites:save', { ...profileRequest(), id: a.id })).toEqual({
      code: 'invalid_operation',
      message: 'This profile is in use',
    });
    expect(await error('sites:delete', { id: a.id })).toEqual({
      code: 'invalid_operation',
      message: 'This profile is in use',
    });
    sessions.login = null;
    expect(await h!.ok('sites:openLogin', { profileId: b.id, url: 'https://login.example.net/start' })).toEqual({});
    expect(sessions.opened[1]).toEqual({ profileId: b.id, url: 'https://login.example.net/start' });
  });

  it('refuses a login address that is not a web address and an unknown profile', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    expect(await error('sites:openLogin', { profileId: a.id, url: 'file:///etc/passwd' })).toMatchObject({
      code: 'validation_failed',
    });
    expect(await error('sites:openLogin', { profileId: crypto.randomUUID() })).toMatchObject({ code: 'not_found' });
    expect(sessions.opened).toEqual([]);
  });

  it('runs one crawl at a time, reports its progress, cancels it and closes its window', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    const blocking = blockingLoader();
    sessions.loader = blocking;
    expect(await h!.ok('sites:crawlProgress', {})).toBeNull();
    const first = h!.call('sites:crawl', { profileId: a.id, url: GALLERY });
    await blocking.started;
    expect(await error('sites:crawl', { profileId: a.id, url: GALLERY })).toEqual({
      code: 'invalid_operation',
      message: 'A site import test is already running',
    });
    // A crawling profile is in use as well.
    expect(await error('sites:save', { ...profileRequest(), id: a.id })).toMatchObject({
      message: 'This profile is in use',
    });
    expect(await h!.ok('sites:crawlProgress', {})).toEqual({ pages: 0, files: 0, cancelling: false });
    expect(await h!.ok('sites:cancelCrawl', {})).toEqual({ cancelling: true });
    const answer = await first;
    expect(answer).toMatchObject({ ok: true, value: { cancelled: true, files: [] } });
    expect(sessions.closed).toBe(1);
    expect(await h!.ok('sites:crawlProgress', {})).toBeNull();
    expect(await h!.ok('sites:cancelCrawl', {})).toEqual({ cancelling: false });
  });

  it('ends a crawl like a cancel when its page window goes away', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    const blocking = blockingLoader();
    sessions.loader = blocking;
    const first = h!.call('sites:crawl', { profileId: a.id, url: GALLERY });
    await blocking.started;
    // What the Electron sessions do on shutdown: the window is destroyed and the crawl told.
    sessions.gone!();
    expect(await first).toMatchObject({ ok: true, value: { cancelled: true, files: [] } });
    expect(await h!.ok('sites:crawlProgress', {})).toBeNull();
  });

  it('closes the window and frees the crawl when the crawl throws', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    sessions.loader = { load: async () => ({ ok: false, reason: 'invalid_xpath', query: 'thumbnails' }) };
    expect(await error('sites:crawl', { profileId: a.id, url: GALLERY })).toMatchObject({ code: 'validation_failed' });
    expect(sessions.pages).toBe(1);
    expect(sessions.closed).toBe(1);
    // Off the site or not a web address: refused before any window opens.
    expect(await error('sites:crawl', { profileId: a.id, url: 'https://elsewhere.org/' })).toEqual({
      code: 'validation_failed',
      message: "This address does not belong to the profile's site",
    });
    expect(await error('sites:crawl', { profileId: a.id, url: 'not a url' })).toMatchObject({
      code: 'validation_failed',
    });
    expect(sessions.pages).toBe(1);
    expect(sessions.closed).toBe(1);
    expect(await h!.ok('sites:crawlProgress', {})).toBeNull();
    sessions.loader = fakeSessions().loader;
    expect(await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY })).toMatchObject({
      files: ['https://example.com/a.jpg', 'https://cdn.example.com/b.png'],
      pages: 1,
      cancelled: false,
    });
  });

  it('imports only the answer of the last crawl, and needs a workspace for it', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    expect(await error('sites:import', { crawlId: crypto.randomUUID(), target: null })).toEqual({
      code: 'invalid_operation',
      message: 'Run the test again',
    });
    const crawl = await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY });
    expect(await error('sites:import', { crawlId: crawl.crawlId, target: null })).toMatchObject({
      code: 'no_workspace_open',
    });
    // A second crawl replaces the answer; a change of the profile drops it.
    const second = await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY });
    expect(await error('sites:import', { crawlId: crawl.crawlId, target: null })).toMatchObject({
      message: 'Run the test again',
    });
    await h!.ok('sites:save', { ...profileRequest({ name: 'Renamed' }), id: a.id });
    expect(await error('sites:import', { crawlId: second.crawlId, target: null })).toMatchObject({
      message: 'Run the test again',
    });
  });

  it('queues site downloads with the filter of the crawl, adds the gallery as a source and refuses deleting the profile meanwhile', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest({ kinds: ['image'], minBytes: 2048 }));
    const crawl = await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY });
    const [type] = await h!.ok('assetTypes:list', {});
    const asset = await h!.ok('assets:create', { name: 'A', typeId: type!.id });
    const result = await h!.ok('sites:import', {
      crawlId: crawl.crawlId,
      target: { assetId: asset.id, role: 'reference' },
    });
    expect(result.queued).toBe(2);
    const detail = await h!.ok('assets:get', { id: asset.id });
    expect(detail.sources.map((s) => s.url)).toEqual([GALLERY]);

    const jobs = await h!.manager.read((s) => s.database.jobs.listByStatus('queued'));
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.payload).toMatchObject({ v: 2, siteProfileId: a.id, filter: { kinds: ['image'], minBytes: 2048 } });
      expect(JSON.stringify(job.payload)).not.toMatch(/cookie|agent/i);
      // Every download of the profile waits in the one lane of its site, which takes one job at a time.
      expect(job.lane).toBe(a.site);
    }
    const limit = siteLaneLimit({ list: () => [a] });
    expect(limit('io', a.site)).toBe(1);
    expect(limit('io', 'img.' + a.site)).toBeUndefined();
    expect(limit('io', null)).toBeUndefined();
    expect(limit('local_gpu', a.site)).toBeUndefined();

    // A second import of the same answer skips what is queued; the existing source does not fail it.
    const again = await h!.ok('sites:import', {
      crawlId: crawl.crawlId,
      target: { assetId: asset.id, role: 'reference' },
    });
    expect(again.queued).toBe(0);
    expect((await h!.ok('assets:get', { id: asset.id })).sources).toHaveLength(1);

    expect(await error('sites:delete', { id: a.id })).toEqual({
      code: 'invalid_operation',
      message: 'This profile still has active downloads',
    });
    expect((await h!.ok('sites:list', {})).profiles).toHaveLength(1);
    await h!.ok('jobs:cancelAll', {});
    expect(await h!.ok('sites:delete', { id: a.id })).toEqual({});
    expect(sessions.cleared).toEqual([a.id]);
  });

  it('keeps the filter of the crawl even when the profile is saved meanwhile', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest({ kinds: ['image'], minBytes: 2048 }));
    const crawl = await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY });
    // A save drops the answer, so an import can never pair it with another filter.
    await h!.ok('sites:save', { ...profileRequest({ kinds: ['video'], minBytes: 0 }), id: a.id });
    expect(await error('sites:import', { crawlId: crawl.crawlId, target: null })).toMatchObject({
      message: 'Run the test again',
    });
    expect(await h!.manager.read((s) => s.database.jobs.listByStatus('queued'))).toEqual([]);
  });

  it('imports into the inbox without adding a source', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest());
    const crawl = await h!.ok('sites:crawl', { profileId: a.id, url: GALLERY });
    expect((await h!.ok('sites:import', { crawlId: crawl.crawlId, target: null })).queued).toBe(2);
    const deleted = await h!.call('sites:delete', { id: a.id });
    expect(deleted.ok).toBe(false);
  });

  /**
   * Queues the two downloads of a crawl of the profile and lets each one fail with `code`, the first one first.
   *
   * @param profileId the profile whose crawl is imported
   * @param code the error code the downloads end with
   * @returns the URLs of the failed jobs in the order they failed
   */
  async function failDownloads(
    profileId: string,
    code: 'download_browser_check' | 'download_blocked',
  ): Promise<string[]> {
    const crawl = await h!.ok('sites:crawl', { profileId, url: GALLERY });
    await h!.ok('sites:import', { crawlId: crawl.crawlId, target: null });
    const urls: string[] = [];
    for (let i = 0; ; i++) {
      const now = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const job = await h!.manager.read((s) =>
        s.database.jobs.claimNext({ resourceClass: 'io', types: ['file.download'], now }),
      );
      if (job === null) return urls;
      await h!.manager.read((s) => s.database.jobs.finish(job.id, { status: 'failed', errorCode: code, now }));
      urls.push((job.payload as { url: string }).url);
    }
  }

  it('opens the site check on the download a browser check refused last, never on a URL of the renderer', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest());
    const failed = await failDownloads(a.id, 'download_browser_check');
    expect(failed).toHaveLength(2);
    expect(await h!.ok('sites:openCheck', { host: a.site })).toEqual({});
    expect(sessions.opened).toEqual([{ profileId: a.id, url: failed[1] }]);
    // The window of the profile is focused again; another profile's check is refused meanwhile.
    expect(await h!.ok('sites:openCheck', { host: a.site })).toEqual({});
    expect(sessions.focused).toBe(1);
    const b = await h!.ok('sites:save', profileRequest({ name: 'Other', url: 'https://other.example.org/' }));
    expect(await error('sites:openCheck', { host: b.site })).toEqual({
      code: 'invalid_operation',
      message: 'Another login window is open',
    });
    expect(sessions.opened).toHaveLength(1);
    expect(await error('sites:openCheck', { host: a.site, url: 'https://evil.example.net/' })).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('opens the start page of the site without a refused download, without a workspace or for another reason', async () => {
    await harness({ workspace: false });
    const a = await h!.ok('sites:save', profileRequest());
    expect(await error('sites:openCheck', { host: 'unknown.example.net' })).toMatchObject({ code: 'not_found' });
    expect(await error('sites:openCheck', { host: 'img.' + a.site })).toMatchObject({ code: 'not_found' });
    expect(await h!.ok('sites:openCheck', { host: a.site })).toEqual({});
    expect(sessions.opened).toEqual([{ profileId: a.id, url: 'https://example.com/' }]);

    await h!.close();
    await harness({ holdJobs: true });
    const c = await h!.ok('sites:save', profileRequest());
    await failDownloads(c.id, 'download_blocked');
    expect(await h!.ok('sites:openCheck', { host: c.site })).toEqual({});
    expect(sessions.opened).toEqual([{ profileId: c.id, url: 'https://example.com/' }]);
  });

  it('ignores a refused download of another profile in the same lane', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest());
    await failDownloads(a.id, 'download_browser_check');
    // A second profile of the same site: the refusals belong to the first one.
    const b = await h!.ok('sites:save', profileRequest({ name: 'Second' }));
    expect(b.site).toBe(a.site);
    const opened = await h!.manager.read((s) => s.database.jobs.listByStatus('failed'));
    expect(opened.every((job) => (job.payload as { siteProfileId: string }).siteProfileId === a.id)).toBe(true);
    // `find` takes the first profile with the site, which owns the refusals.
    expect(await h!.ok('sites:openCheck', { host: a.site })).toEqual({});
    expect(sessions.opened[0]!.profileId).toBe(a.id);
    expect(sessions.opened[0]!.url).not.toBe('https://example.com/');
  });

  it('queues the downloads a browser check refused again when the lane of a profile resumes, and nothing else', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest());
    await failDownloads(a.id, 'download_browser_check');
    expect(await h!.ok('jobs:resumeHost', { host: a.site })).toEqual({});
    expect((await h!.manager.read((s) => s.database.jobs.listByStatus('queued'))).map((job) => job.lane)).toEqual([
      a.site,
      a.site,
    ]);

    // Other failures of the lane stay failed.
    await h!.ok('jobs:cancelAll', {});
    await h!.ok('jobs:clearFinished', {});
    await failDownloads(a.id, 'download_blocked');
    expect(await h!.ok('jobs:resumeHost', { host: a.site })).toEqual({});
    expect(await h!.manager.read((s) => s.database.jobs.listByStatus('queued'))).toEqual([]);
    expect(await h!.manager.read((s) => s.database.jobs.listByStatus('failed'))).toHaveLength(2);
  });

  it('leaves a lane that is no profile site alone on resume', async () => {
    await harness({ holdJobs: true });
    const a = await h!.ok('sites:save', profileRequest());
    await failDownloads(a.id, 'download_browser_check');
    // The profile is gone: its lane is a plain host lane now.
    expect(await h!.ok('sites:delete', { id: a.id })).toEqual({});
    expect(await h!.ok('jobs:resumeHost', { host: a.site })).toEqual({});
    expect(await h!.manager.read((s) => s.database.jobs.listByStatus('queued'))).toEqual([]);
  });

  it('waits abortably between page loads', async () => {
    const controller = new AbortController();
    const waiting = abortableWait(60_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    await expect(abortableWait(1, new AbortController().signal)).resolves.toBeUndefined();
    const aborted = new AbortController();
    aborted.abort(new Error('early'));
    await expect(abortableWait(1, aborted.signal)).rejects.toThrow('early');
  });
});
