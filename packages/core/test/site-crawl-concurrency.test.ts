import { describe, expect, it, vi } from 'vitest';
import type { SiteProfile } from '@assetforge/contracts';
import {
  crawlSite,
  parseSiteCrawlCheckpoint,
  SiteCrawlBlockedError,
  type PageLoadResult,
  type SiteCrawlDependencies,
  type SiteCrawlCheckpoint,
} from '../src/index.js';

const origin = 'https://gallery.test';
const profile: SiteProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Gallery',
  site: 'gallery.test',
  thumbnails: '//a/@href',
  pagination: '',
  file: '//img/@src',
  kinds: ['image'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};

function loaded(url: string, results: Record<string, string[]>): PageLoadResult {
  return { ok: true, results, baseUrl: url, finalUrl: url };
}

describe('bounded detail-page extraction', () => {
  it('starts the configured number of independent details before the first detail finishes', async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    const release: (() => void)[] = [];
    const configured = { ...profile, detailConcurrency: 3, requestGapMs: 0 };
    const dependencies: SiteCrawlDependencies = {
      robots: async () => ({ kind: 'none' }),
      wait: async () => {},
      pages: {
        async load(url) {
          if (url === `${origin}/gallery`) return loaded(url, { thumbnails: ['/d/1', '/d/2', '/d/3', '/d/4'] });
          opened.push(url);
          await new Promise<void>((resolve) => release.push(resolve));
          return loaded(url, { file: [`${url}.jpg`] });
        },
      },
    };
    const pending = crawlSite(dependencies, {
      profile: configured,
      url: `${origin}/gallery`,
      signal: controller.signal,
    });
    try {
      for (let tick = 0; tick < 50; tick++) await Promise.resolve();
      expect(opened).toEqual([`${origin}/d/1`, `${origin}/d/2`, `${origin}/d/3`]);
    } finally {
      controller.abort();
      release.forEach((resolve) => resolve());
      await pending;
    }
  });

  it('paces navigation starts without adding another full gap after a slow page', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const starts: number[] = [];
    const dependencies: SiteCrawlDependencies = {
      robots: async () => ({ kind: 'none' }),
      wait: async (ms) => {
        now += ms;
      },
      pages: {
        async load(url) {
          starts.push(now);
          if (url === `${origin}/gallery`) {
            now += 800;
            return loaded(url, { thumbnails: ['/d/1', '/d/2'] });
          }
          now += 100;
          return loaded(url, { file: [`${url}.jpg`] });
        },
      },
    };
    try {
      await crawlSite(dependencies, {
        profile: { ...profile, detailConcurrency: 1, requestGapMs: 500 },
        url: `${origin}/gallery`,
        signal: new AbortController().signal,
      });
      expect(starts).toEqual([0, 800, 1300]);
    } finally {
      clock.mockRestore();
    }
  });

  it('resumes a checkpoint without reloading completed details or losing their provenance', async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    let checkpoint: SiteCrawlCheckpoint | undefined;
    const configured = { ...profile, detailConcurrency: 1, requestGapMs: 0 };
    const dependencies: SiteCrawlDependencies = {
      robots: async () => ({ kind: 'none' }),
      wait: async () => {},
      pages: {
        async load(url) {
          opened.push(url);
          return url === `${origin}/gallery`
            ? loaded(url, { thumbnails: ['/d/1', '/d/2', '/d/3'] })
            : loaded(url, { file: [`${url}.jpg`] });
        },
      },
    };
    const first = await crawlSite(dependencies, {
      profile: configured,
      url: `${origin}/gallery`,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.files === 1) controller.abort();
      },
      onCheckpoint: (state) => {
        checkpoint = state;
      },
    });
    expect(first).toMatchObject({ files: [`${origin}/d/1.jpg`], cancelled: true });
    const restored = parseSiteCrawlCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    expect(restored?.sourcePages[`${origin}/d/1.jpg`]).toBe(`${origin}/d/1`);
    expect(restored?.pendingPages).toEqual([`${origin}/gallery`]);
    opened.length = 0;
    const result = await crawlSite(dependencies, {
      profile: configured,
      url: `${origin}/gallery`,
      signal: new AbortController().signal,
      checkpoint: restored!,
    });
    expect(result).toMatchObject({
      files: [`${origin}/d/1.jpg`, `${origin}/d/2.jpg`, `${origin}/d/3.jpg`],
      pages: 1,
      cancelled: false,
    });
    expect(opened).toEqual([`${origin}/gallery`, `${origin}/d/2`, `${origin}/d/3`]);
  });

  it.each([401, 403, 429] as const)('stops on HTTP %i and checkpoints earlier results for retry', async (status) => {
    let checkpoint: SiteCrawlCheckpoint | undefined;
    const dependencies: SiteCrawlDependencies = {
      robots: async () => ({ kind: 'none' }),
      wait: async () => {},
      pages: {
        async load(url) {
          if (url === `${origin}/gallery`) return loaded(url, { thumbnails: ['/d/1', '/d/2', '/d/3'] });
          if (url.endsWith('/d/2')) return { ok: false, reason: 'http_error', status };
          return loaded(url, { file: [`${url}.jpg`] });
        },
      },
    };
    await expect(
      crawlSite(dependencies, {
        profile: { ...profile, detailConcurrency: 1, requestGapMs: 0 },
        url: `${origin}/gallery`,
        signal: new AbortController().signal,
        onCheckpoint: (state) => {
          checkpoint = state;
        },
      }),
    ).rejects.toMatchObject({ status, code: new SiteCrawlBlockedError(status).code });
    expect(checkpoint?.answer.files).toEqual([`${origin}/d/1.jpg`]);
    expect(checkpoint?.completedDetails).toEqual([`${origin}/d/1`]);
  });

  it('settles every worker and never exceeds maxFiles when workers finish together', async () => {
    const dependencies: SiteCrawlDependencies = {
      robots: async () => ({ kind: 'none' }),
      wait: async () => {},
      pages: {
        async load(url) {
          return url === `${origin}/gallery`
            ? loaded(url, { thumbnails: ['/d/1', '/d/2', '/d/3'] })
            : loaded(url, { file: [`${url}.jpg`, `${url}-second.jpg`] });
        },
      },
    };
    const result = await crawlSite(dependencies, {
      profile: { ...profile, detailConcurrency: 3, requestGapMs: 0, maxFiles: 2 },
      url: `${origin}/gallery`,
      signal: new AbortController().signal,
    });
    expect(result.files).toHaveLength(2);
    expect(result).toMatchObject({ truncated: 'files', cancelled: false });
    const saved = [...result.files];
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(result.files).toEqual(saved);
  });

  it('rejects malformed persisted crawl state', () => {
    expect(parseSiteCrawlCheckpoint(null)).toBeNull();
    expect(parseSiteCrawlCheckpoint({ answer: {}, pendingPages: ['file:///private'] })).toBeNull();
  });
});
