import { describe, expect, it } from 'vitest';
import type { SiteProfile } from '@assetforge/contracts';
import { crawlSite, type PageLoadResult, type SiteCrawlDependencies } from '../src/index.js';

const origin = 'https://gallery.test';
const profile: SiteProfile = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Gallery', site: 'gallery.test',
  thumbnails: '//a/@href', pagination: '', file: '//img/@src', kinds: ['image'],
  minBytes: 0, urlContains: '', maxPages: 20, maxFiles: 1000,
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
      pages: { async load(url) {
        if (url === `${origin}/gallery`) return loaded(url, { thumbnails: ['/d/1', '/d/2', '/d/3', '/d/4'] });
        opened.push(url);
        await new Promise<void>((resolve) => release.push(resolve));
        return loaded(url, { file: [`${url}.jpg`] });
      } },
    };
    const pending = crawlSite(dependencies, { profile: configured, url: `${origin}/gallery`, signal: controller.signal });
    try {
      for (let tick = 0; tick < 50; tick++) await Promise.resolve();
      expect(opened).toEqual([`${origin}/d/1`, `${origin}/d/2`, `${origin}/d/3`]);
    } finally {
      controller.abort();
      release.forEach((resolve) => resolve());
      await pending;
    }
  });
});
