import { describe, expect, it } from 'vitest';
import {
  SITE_MAX_PROBLEMS,
  SiteCrawlResultSchema,
  type SiteCrawlProblem,
  type SiteProfile,
} from '@assetforge/contracts';
import {
  crawlSite,
  InvalidOperationError,
  PAGE_GAP_MS,
  parseRobots,
  siteGalleryUrl,
  ValidationFailedError,
  type PageLoadResult,
  type RobotsAnswer,
  type SiteCrawlDependencies,
} from '../src/index.js';

const SITE = 'gallery.test';
const G = `https://${SITE}`;

function profile(over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Gallery',
    site: SITE,
    thumbnails: '//a[@class="thumb"]',
    pagination: '',
    file: '',
    kinds: ['image', 'video'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
    detailConcurrency: 1,
    ...over,
  };
}

type Page = PageLoadResult | ((signal: AbortSignal) => PageLoadResult | Promise<PageLoadResult>);
type Load = { url: string; queries: Record<string, string>; waitFor: string };

/**
 * A loaded page; without `baseUrl` or `finalUrl` the double answers the requested URL for it, like a page without
 * redirect.
 */
const ok = (results: Record<string, string[]>, baseUrl = '', finalUrl = ''): PageLoadResult => ({
  ok: true,
  results,
  baseUrl,
  finalUrl,
});

function deps(
  pages: Record<string, Page>,
  robots: Record<string, RobotsAnswer | string> = {},
): SiteCrawlDependencies & { loads: Load[]; waits: number[]; robotsAsked: string[]; events: string[] } {
  const loads: Load[] = [];
  const waits: number[] = [];
  const robotsAsked: string[] = [];
  const events: string[] = [];
  let now = 0;
  return {
    now: () => now,
    loads,
    waits,
    robotsAsked,
    events,
    pages: {
      async load(url, r) {
        loads.push({ url, queries: r.queries, waitFor: r.waitFor });
        events.push(`load ${url}`);
        const page = pages[url];
        if (page === undefined) return { ok: false, reason: 'failed' };
        const result = typeof page === 'function' ? await page(r.signal) : page;
        if (!result.ok) return result;
        return { ...result, baseUrl: result.baseUrl || url, finalUrl: result.finalUrl || url };
      },
    },
    async robots(origin) {
      robotsAsked.push(origin);
      const answer = robots[origin];
      if (answer === undefined) return { kind: 'none' };
      if (typeof answer === 'string') return { kind: 'rules', rules: parseRobots(answer) };
      return answer;
    },
    async wait(ms) {
      now += ms;
      waits.push(ms);
      events.push(`wait ${ms}`);
    },
  };
}

/** Every failed page outcome but invalid_xpath. */
const PAGE_FAILURES: readonly PageLoadResult[] = [
  { ok: false, reason: 'timeout' },
  { ok: false, reason: 'no_match' },
  { ok: false, reason: 'left_site', host: 'login.other.test' },
  { ok: false, reason: 'left_site', host: '' },
  { ok: false, reason: 'http_error', status: 502 },
  { ok: false, reason: 'failed' },
];

/** The problem a failed page of `stage` records. */
function problemOf(url: string, stage: 'gallery' | 'detail', page: PageLoadResult): SiteCrawlProblem {
  if (page.ok || page.reason === 'invalid_xpath') throw new Error('not a failure');
  switch (page.reason) {
    case 'no_match':
      return { url, stage, reason: stage === 'gallery' ? 'no_thumbnails' : 'no_file', detail: null };
    case 'timeout':
      return { url, stage, reason: 'timeout', detail: null };
    case 'left_site':
      return { url, stage, reason: 'left_site', detail: page.host };
    case 'http_error':
      return { url, stage, reason: 'http_error', detail: String(page.status) };
    case 'failed':
      return { url, stage, reason: 'load_failed', detail: null };
  }
}

const run = (d: SiteCrawlDependencies, p: SiteProfile, url = `${G}/g`, signal = new AbortController().signal) =>
  crawlSite(d, { profile: p, url, signal });

describe('crawlSite', () => {
  it('answers the thumbnail links as files when there is no file expression', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/f/1.jpg', 'https://cdn.other.test/2.png'] }) });
    const result = await run(d, profile());
    expect(result).toEqual({
      files: [`${G}/f/1.jpg`, 'https://cdn.other.test/2.png'],
      pages: 1,
      duplicates: 0,
      filtered: 0,
      disallowed: 0,
      invalid: 0,
      offSite: 0,
      pageFailures: 0,
      truncated: null,
      cancelled: false,
      problems: [],
      problemsDropped: 0,
    });
    expect(d.loads).toEqual([{ url: `${G}/g`, queries: { thumbnails: '//a[@class="thumb"]' }, waitFor: 'thumbnails' }]);
  });

  it('asks pagination on a gallery page when it is set', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: [], pagination: [] }) });
    await run(d, profile({ pagination: '//a[@rel="next"]' }));
    expect(d.loads[0]!.queries).toEqual({ thumbnails: '//a[@class="thumb"]', pagination: '//a[@rel="next"]' });
  });

  it('refuses a gallery URL off the site', async () => {
    const d = deps({});
    await expect(run(d, profile(), 'https://evilgallery.test/g')).rejects.toThrow(
      new ValidationFailedError("This address does not belong to the profile's site"),
    );
    await expect(run(d, profile(), 'not a url')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(d.loads).toEqual([]);
  });

  it('accepts a gallery URL on a subdomain of the site', async () => {
    const d = deps({ 'https://www.gallery.test/g': ok({ thumbnails: ['/1.jpg'] }) });
    const result = await run(d, profile(), 'https://www.gallery.test/g');
    expect(result.files).toEqual(['https://www.gallery.test/1.jpg']);
  });

  it('names the gallery URL it would crawl, or refuses it like the crawl', () => {
    expect(siteGalleryUrl(profile(), `${G}/g#top`)).toBe(`${G}/g`);
    expect(() => siteGalleryUrl(profile(), 'https://evilgallery.test/g')).toThrow(
      new ValidationFailedError("This address does not belong to the profile's site"),
    );
    expect(() => siteGalleryUrl(profile(), 'not a url')).toThrow(ValidationFailedError);
  });

  it('resolves links against the final URL of an in-site redirect', async () => {
    const d = deps(
      {
        [`${G}/gallery`]: ok({ thumbnails: ['img/1.jpg'], pagination: ['page2'] }, `${G}/gallery/`),
        [`${G}/gallery/page2`]: ok({ thumbnails: ['img/2.jpg'], pagination: [] }),
      },
      {},
    );
    const result = await run(d, profile({ pagination: '//a[@rel="next"]' }), `${G}/gallery`);
    expect(result).toMatchObject({
      files: [`${G}/gallery/img/1.jpg`, `${G}/gallery/img/2.jpg`],
      pages: 2,
      pageFailures: 0,
    });
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/gallery`, `${G}/gallery/page2`]);
  });

  it('counts the final URL of an in-site redirect as seen, so a link back to it is not loaded again', async () => {
    const d = deps({
      [`${G}/gallery`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/gallery/p2'] }, `${G}/gallery/`, `${G}/gallery/`),
      [`${G}/gallery/p2`]: ok({ thumbnails: ['/2.jpg'], pagination: ['/gallery/', '/gallery'] }),
    });
    const result = await run(d, profile({ pagination: '//a[@rel="next"]', maxPages: 2 }), `${G}/gallery`);
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/gallery`, `${G}/gallery/p2`]);
    // The final URL is no page of its own: it neither counts toward maxPages nor truncates the crawl.
    expect(result).toMatchObject({ pages: 2, truncated: null });
  });

  it('ignores a final URL off the site or that is no URL', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: [], pagination: ['/g?p=2'] }, '', 'https://other.test/g?p=2'),
      [`${G}/g?p=2`]: ok({ thumbnails: [], pagination: ['/g?p=3'] }, '', 'not a url'),
      [`${G}/g?p=3`]: ok({ thumbnails: [], pagination: [] }),
    });
    await run(d, profile({ pagination: '//p' }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/g?p=2`, `${G}/g?p=3`]);
  });

  it.each(['https://other.example/x', 'not a url'])(
    'a final URL %j is not seen, not followed and not reported, on a gallery and a detail page',
    async (finalUrl) => {
      const d = deps({
        [`${G}/g`]: ok({ thumbnails: ['/d/1', '/d/2'], pagination: ['/g?p=2'] }, '', finalUrl),
        [`${G}/g?p=2`]: ok({ thumbnails: [], pagination: [] }),
        [`${G}/d/1`]: ok({ file: ['/f/1.jpg'] }, '', finalUrl),
        [`${G}/d/2`]: ok({ file: ['/f/2.jpg'] }, '', finalUrl),
      });
      const result = await run(d, profile({ pagination: '//p', file: '//img', maxPages: 2 }));
      expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/d/1`, `${G}/d/2`, `${G}/g?p=2`]);
      expect(result).toMatchObject({
        files: [`${G}/f/1.jpg`, `${G}/f/2.jpg`],
        pages: 2,
        pageFailures: 0,
        invalid: 0,
        offSite: 0,
        truncated: null,
        problems: [],
      });
    },
  );

  it('loads a detail page once when a thumbnail links to the final URL of another', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/d/1', '/d/1/'] }),
      [`${G}/d/1`]: ok({ file: ['/f/1.jpg'] }, '', `${G}/d/1/`),
      [`${G}/d/1/`]: ok({ file: ['/f/1.jpg'] }),
    });
    const result = await run(d, profile({ file: '//img' }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/d/1`]);
    expect(result.files).toEqual([`${G}/f/1.jpg`]);
  });

  it('resolves detail file links against the final URL of the detail page', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/d/1'] }),
      [`${G}/d/1`]: ok({ file: ['full.jpg'] }, `${G}/d/1/`),
    });
    const result = await run(d, profile({ file: '//img' }));
    expect(result.files).toEqual([`${G}/d/1/full.jpg`]);
  });

  it('ignores a base off the site or no URL and resolves against the requested URL', async () => {
    for (const base of ['https://evil.test/x/', 'not a url', 'about:blank']) {
      const d = deps({ [`${G}/a/g`]: ok({ thumbnails: ['1.jpg'] }, base) });
      const result = await run(d, profile(), `${G}/a/g`);
      expect(result).toMatchObject({ files: [`${G}/a/1.jpg`], pages: 1 });
    }
  });

  it('drops a page whose final URL robots disallows', async () => {
    const d = deps(
      { [`${G}/g`]: ok({ thumbnails: ['/1.jpg'] }, `${G}/private/g`) },
      { [G]: 'User-agent: *\nDisallow: /private' },
    );
    const result = await run(d, profile());
    expect(result).toMatchObject({ files: [], pages: 0, disallowed: 1 });
  });

  it('drops a detail page whose final URL robots disallows', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({ thumbnails: ['/d/1'] }),
        [`${G}/d/1`]: ok({ file: ['/f/1.jpg'] }, `${G}/private/1`),
      },
      { [G]: 'User-agent: *\nDisallow: /private' },
    );
    const result = await run(d, profile({ file: '//img' }));
    expect(result).toMatchObject({ files: [], pages: 1, disallowed: 1 });
  });

  it('throws when the robots.txt of the gallery origin cannot be read', async () => {
    const d = deps({}, { [G]: { kind: 'unavailable' } });
    await expect(run(d, profile())).rejects.toThrow(
      new InvalidOperationError("The site's robots.txt could not be read"),
    );
    expect(d.loads).toEqual([]);
  });

  it('does not load a gallery page robots disallows', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/1.jpg'] }) }, { [G]: 'User-agent: *\nDisallow: /g' });
    const result = await run(d, profile());
    expect(d.loads).toEqual([]);
    expect(result).toMatchObject({ files: [], pages: 0, disallowed: 1 });
  });

  it('maps an invalid expression to its fixed message', async () => {
    for (const [query, message] of [
      ['thumbnails', 'The thumbnail expression is not valid XPath'],
      ['pagination', 'The pagination expression is not valid XPath'],
      ['file', 'The file expression is not valid XPath'],
    ] as const) {
      const d = deps({
        [`${G}/g`]: query === 'file' ? ok({ thumbnails: ['/d/1'] }) : { ok: false, reason: 'invalid_xpath', query },
        [`${G}/d/1`]: { ok: false, reason: 'invalid_xpath', query },
      });
      await expect(run(d, profile({ pagination: '//p', file: query === 'file' ? '//img' : '' }))).rejects.toThrow(
        new ValidationFailedError(message),
      );
    }
  });

  it('follows pagination, visits each page once and stops on a cycle', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2', '/g', '#top'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/1.jpg', '/2.jpg'], pagination: ['/g', '/g?p=2', '/g?p=3'] }),
      [`${G}/g?p=3`]: ok({ thumbnails: ['/2.jpg'], pagination: ['/g'] }),
    });
    const result = await run(d, profile({ pagination: '//a[@rel="next"]' }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/g?p=2`, `${G}/g?p=3`]);
    expect(result).toMatchObject({ files: [`${G}/1.jpg`, `${G}/2.jpg`], pages: 3, duplicates: 2, truncated: null });
  });

  it('answers each file once when every page lists the same thumbnails', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg', '/2.jpg'], pagination: ['/g?p=2'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/1.jpg', '/2.jpg'], pagination: ['/g?p=3'] }),
      [`${G}/g?p=3`]: ok({ thumbnails: ['/1.jpg', '/2.jpg'], pagination: ['/g'] }),
    });
    const result = await run(d, profile({ pagination: '//p' }));
    expect(result).toMatchObject({ files: [`${G}/1.jpg`, `${G}/2.jpg`], pages: 3, duplicates: 4 });
  });

  it('does not follow pagination off the site or disallowed by robots', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['https://other.test/g2', '/private/g', '/g2'] }),
        [`${G}/g2`]: ok({ thumbnails: ['/2.jpg'] }),
      },
      { [G]: 'User-agent: *\nDisallow: /private' },
    );
    const result = await run(d, profile({ pagination: '//p', maxPages: 2 }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/g2`]);
    expect(result).toMatchObject({ pages: 2, disallowed: 1, truncated: null });
  });

  it('stops queuing pages at maxPages and answers truncated pages', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2', '/g?p=3'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/2.jpg'], pagination: ['/g?p=3'] }),
      [`${G}/g?p=3`]: ok({ thumbnails: ['/3.jpg'] }),
    });
    const result = await run(d, profile({ pagination: '//p', maxPages: 2 }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/g?p=2`]);
    expect(result).toMatchObject({ pages: 2, truncated: 'pages', files: [`${G}/1.jpg`, `${G}/2.jpg`] });
  });

  it('loads each distinct detail page once and answers its file links', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/d/1', '/d/2', '/d/1'], pagination: ['/g?p=2'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/d/2', '/d/3'] }),
      [`${G}/d/1`]: ok({ file: ['/files/1.jpg'] }),
      [`${G}/d/2`]: ok({ file: ['https://cdn.other.test/2.mp4', '/files/1.jpg'] }),
      [`${G}/d/3`]: { ok: false, reason: 'timeout' },
    });
    const result = await run(d, profile({ pagination: '//p', file: '//img/@src', maxPages: 2 }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/d/1`, `${G}/d/2`, `${G}/g?p=2`, `${G}/d/3`]);
    expect(d.loads[1]).toEqual({ url: `${G}/d/1`, queries: { file: '//img/@src' }, waitFor: 'file' });
    expect(result).toMatchObject({
      files: [`${G}/files/1.jpg`, 'https://cdn.other.test/2.mp4'],
      pages: 2,
      duplicates: 1,
      pageFailures: 1,
      truncated: null,
    });
  });

  it('does not load detail pages off the site or disallowed by robots', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({ thumbnails: ['https://other.test/d/1', '/private/d/2', '/d/3'] }),
        [`${G}/d/3`]: ok({ file: ['/3.jpg'] }),
      },
      { [G]: 'User-agent: *\nDisallow: /private' },
    );
    const result = await run(d, profile({ file: '//img' }));
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/d/3`]);
    expect(result).toMatchObject({ files: [`${G}/3.jpg`], disallowed: 1 });
  });

  it('counts a failed page and goes on', async () => {
    for (const failure of PAGE_FAILURES) {
      const d = deps({
        [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2', '/g?p=3'] }),
        [`${G}/g?p=2`]: failure,
        [`${G}/g?p=3`]: ok({ thumbnails: ['/3.jpg'] }),
      });
      const result = await run(d, profile({ pagination: '//p' }));
      expect(result).toMatchObject({ files: [`${G}/1.jpg`, `${G}/3.jpg`], pages: 2, pageFailures: 1 });
    }
  });

  it('answers zero files and a page failure when the gallery never matches', async () => {
    const d = deps({ [`${G}/g`]: { ok: false, reason: 'timeout' } });
    const result = await run(d, profile());
    expect(result).toMatchObject({ files: [], pages: 0, pageFailures: 1, cancelled: false });
  });

  it('counts strings that are no usable URL as invalid', async () => {
    const d = deps({
      [`${G}/g`]: ok({
        thumbnails: ['javascript:alert(1)', 'https://user:pw@gallery.test/1.jpg', '', 'ftp://x.test/a.jpg', '/ok.jpg'],
      }),
    });
    const result = await run(d, profile());
    expect(result).toMatchObject({ files: [`${G}/ok.jpg`], invalid: 4 });
  });

  it('makes files unique by their normalised form', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg', 'HTTPS://GALLERY.TEST/1.jpg', '/1.jpg#x', ' /1.jpg '] }),
    });
    const result = await run(d, profile());
    expect(result).toMatchObject({ files: [`${G}/1.jpg`], duplicates: 3 });
  });

  it('filters by urlContains regardless of case', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/full/1.jpg', '/small/2.jpg', '/FULL/3.jpg'] }) });
    const result = await run(d, profile({ urlContains: 'Full/' }));
    expect(result).toMatchObject({ files: [`${G}/full/1.jpg`, `${G}/FULL/3.jpg`], filtered: 1 });
  });

  it('filters by the kind of a known extension only', async () => {
    const d = deps({
      [`${G}/g`]: ok({
        thumbnails: ['/download.php?id=7', '/a.pdf', '/b.JPG', '/c.webm', '/d', '/e.blend', '/f.html'],
      }),
    });
    const result = await run(d, profile({ kinds: ['image', 'video'] }));
    expect(result).toMatchObject({
      files: [`${G}/download.php?id=7`, `${G}/b.JPG`, `${G}/c.webm`, `${G}/d`, `${G}/f.html`],
      filtered: 2,
    });
  });

  it('checks files against the robots of their own origin, reading each origin once', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({
          thumbnails: [
            '/a/1.jpg',
            '/blocked/2.jpg',
            'https://cdn.other.test/3.jpg',
            'https://cdn.other.test/no/4.jpg',
            'https://cdn.other.test/5.jpg',
          ],
          pagination: ['/g?p=2'],
        }),
        [`${G}/g?p=2`]: ok({ thumbnails: ['https://cdn.other.test/6.jpg'] }),
      },
      { [G]: 'User-agent: *\nDisallow: /blocked', 'https://cdn.other.test': 'User-agent: *\nDisallow: /no' },
    );
    const result = await run(d, profile({ pagination: '//p' }));
    expect(result).toMatchObject({
      files: [
        `${G}/a/1.jpg`,
        'https://cdn.other.test/3.jpg',
        'https://cdn.other.test/5.jpg',
        'https://cdn.other.test/6.jpg',
      ],
      disallowed: 2,
    });
    expect(d.robotsAsked).toEqual([G, 'https://cdn.other.test']);
  });

  it('drops only the URLs of another origin whose robots cannot be read', async () => {
    const d = deps(
      { [`${G}/g`]: ok({ thumbnails: ['/1.jpg', 'https://cdn.other.test/2.jpg', 'https://cdn.other.test/3.jpg'] }) },
      { 'https://cdn.other.test': { kind: 'unavailable' } },
    );
    const result = await run(d, profile());
    expect(result).toMatchObject({ files: [`${G}/1.jpg`], disallowed: 2 });
    expect(d.robotsAsked).toEqual([G, 'https://cdn.other.test']);
  });

  it('does not ask robots for a file that is filtered out first', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['https://cdn.other.test/a.pdf'] }) });
    await run(d, profile());
    expect(d.robotsAsked).toEqual([G]);
  });

  it('cuts files at maxFiles and answers truncated files', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg', '/2.jpg', '/3.jpg'], pagination: ['/g?p=2'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/4.jpg'] }),
    });
    const result = await run(d, profile({ pagination: '//p', maxFiles: 2 }));
    expect(result).toMatchObject({ files: [`${G}/1.jpg`, `${G}/2.jpg`], truncated: 'files' });
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`]);
  });

  it('answers truncated null when exactly maxFiles were found', async () => {
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/1.jpg', '/2.jpg'] }) });
    const result = await run(d, profile({ maxFiles: 2 }));
    expect(result).toMatchObject({ files: [`${G}/1.jpg`, `${G}/2.jpg`], truncated: null });
  });

  it('waits PAGE_GAP_MS between two loads and not before the first', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/d/1'], pagination: ['/g?p=2'] }),
      [`${G}/d/1`]: ok({ file: ['/1.jpg'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: [] }),
    });
    await run(d, profile({ pagination: '//p', file: '//img' }));
    expect(PAGE_GAP_MS).toBe(500);
    expect(d.events).toEqual([
      `load ${G}/g`,
      `wait ${PAGE_GAP_MS}`,
      `load ${G}/d/1`,
      `wait ${PAGE_GAP_MS}`,
      `load ${G}/g?p=2`,
    ]);
  });

  it('reports progress after each page', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['/2.jpg'] }),
    });
    const seen: unknown[] = [];
    await crawlSite(d, {
      profile: profile({ pagination: '//p' }),
      url: `${G}/g`,
      signal: new AbortController().signal,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([
      { pages: 1, files: 1 },
      { pages: 2, files: 2 },
    ]);
  });

  it('answers what was found so far on a cancel during a load', async () => {
    const controller = new AbortController();
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2', '/g?p=3'] }),
      [`${G}/g?p=2`]: () => {
        controller.abort(new Error('cancel'));
        return { ok: false, reason: 'failed' };
      },
      [`${G}/g?p=3`]: ok({ thumbnails: ['/3.jpg'] }),
    });
    const result = await run(d, profile({ pagination: '//p' }), `${G}/g`, controller.signal);
    expect(result).toMatchObject({ files: [`${G}/1.jpg`], pages: 1, pageFailures: 0, cancelled: true });
    expect(d.loads.map((l) => l.url)).toEqual([`${G}/g`, `${G}/g?p=2`]);
  });

  it('answers what was found so far when the wait rejects on a cancel', async () => {
    const controller = new AbortController();
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/1.jpg'], pagination: ['/g?p=2'] }) });
    d.wait = async (_ms, signal) => {
      controller.abort(new Error('cancel'));
      throw signal.reason;
    };
    const result = await run(d, profile({ pagination: '//p' }), `${G}/g`, controller.signal);
    expect(result).toMatchObject({ files: [`${G}/1.jpg`], cancelled: true });
  });

  it('answers an empty cancelled result when cancelled before the first load', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/1.jpg'] }) });
    const result = await run(d, profile(), `${G}/g`, controller.signal);
    expect(result).toMatchObject({ files: [], pages: 0, cancelled: true });
    expect(d.loads).toEqual([]);
  });

  it('lets a thrown loader error through when not cancelled', async () => {
    const d = deps({});
    d.pages = {
      async load() {
        throw new Error('window crashed');
      },
    };
    await expect(run(d, profile())).rejects.toThrow('window crashed');
  });
});

describe('crawl problems', () => {
  it('answers normally with the problem when the first gallery page fails', async () => {
    for (const failure of PAGE_FAILURES) {
      const d = deps({ [`${G}/g`]: failure });
      const result = await run(d, profile());
      expect(result).toEqual({
        files: [],
        pages: 0,
        duplicates: 0,
        filtered: 0,
        disallowed: 0,
        invalid: 0,
        offSite: 0,
        pageFailures: 1,
        truncated: null,
        cancelled: false,
        problems: [problemOf(`${G}/g`, 'gallery', failure)],
        problemsDropped: 0,
      });
    }
  });

  it('names no_thumbnails for a gallery page and no_file for a detail page that matched nothing', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/d/1'], pagination: ['/g?p=2'] }),
      [`${G}/d/1`]: { ok: false, reason: 'no_match' },
      [`${G}/g?p=2`]: { ok: false, reason: 'no_match' },
    });
    const result = await run(d, profile({ pagination: '//p', file: '//img' }));
    expect(result.problems).toEqual([
      { url: `${G}/d/1`, stage: 'detail', reason: 'no_file', detail: null },
      { url: `${G}/g?p=2`, stage: 'gallery', reason: 'no_thumbnails', detail: null },
    ]);
    expect(result.pageFailures).toBe(2);
  });

  it('records every failed detail page outcome', async () => {
    for (const failure of PAGE_FAILURES) {
      const d = deps({ [`${G}/g`]: ok({ thumbnails: ['/d/1'] }), [`${G}/d/1`]: failure });
      const result = await run(d, profile({ file: '//img' }));
      expect(result).toMatchObject({ pages: 1, pageFailures: 1, problems: [problemOf(`${G}/d/1`, 'detail', failure)] });
    }
  });

  it('records robots_disallowed for the gallery, a detail page, a pagination target, a file and a page base', async () => {
    const robots = { [G]: 'User-agent: *\nDisallow: /private' };
    const gallery = await run(deps({}, robots), profile(), `${G}/private/g`);
    expect(gallery.problems).toEqual([
      { url: `${G}/private/g`, stage: 'gallery', reason: 'robots_disallowed', detail: null },
    ]);
    expect(gallery.disallowed).toBe(1);

    const d = deps(
      {
        [`${G}/g`]: ok({ thumbnails: ['/private/d/1', '/d/2'], pagination: ['/private/g2'] }),
        [`${G}/d/2`]: ok({ file: ['/private/2.jpg', '/3.jpg'] }),
      },
      robots,
    );
    const result = await run(d, profile({ pagination: '//p', file: '//img' }));
    expect(result.files).toEqual([`${G}/3.jpg`]);
    expect(result.problems).toEqual([
      { url: `${G}/private/d/1`, stage: 'detail', reason: 'robots_disallowed', detail: null },
      { url: `${G}/private/2.jpg`, stage: 'file', reason: 'robots_disallowed', detail: null },
      { url: `${G}/private/g2`, stage: 'gallery', reason: 'robots_disallowed', detail: null },
    ]);
    expect(result.disallowed).toBe(3);

    const based = await run(deps({ [`${G}/g`]: ok({ thumbnails: ['/1.jpg'] }, `${G}/private/g`) }, robots), profile());
    expect(based.problems).toEqual([
      { url: `${G}/private/g`, stage: 'gallery', reason: 'robots_disallowed', detail: null },
    ]);
    expect(based.disallowed).toBe(1);
  });

  it('records robots_unavailable with the host for each URL of an origin whose robots.txt cannot be read', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({
          thumbnails: ['/1.jpg', 'https://cdn.other.test:8443/2.jpg', 'https://cdn.other.test:8443/3.jpg'],
        }),
      },
      { 'https://cdn.other.test:8443': { kind: 'unavailable' } },
    );
    const result = await run(d, profile());
    expect(result.problems).toEqual([
      {
        url: 'https://cdn.other.test:8443/2.jpg',
        stage: 'file',
        reason: 'robots_unavailable',
        detail: 'cdn.other.test:8443',
      },
      {
        url: 'https://cdn.other.test:8443/3.jpg',
        stage: 'file',
        reason: 'robots_unavailable',
        detail: 'cdn.other.test:8443',
      },
    ]);
    expect(result.disallowed).toBe(2);
  });

  it('keeps a long host out of the answer so it still passes the contract', async () => {
    const host = `${'a'.repeat(300)}.test`;
    const d = deps(
      { [`${G}/g`]: ok({ thumbnails: [`https://${host}/1.jpg`] }) },
      { [`https://${host}`]: { kind: 'unavailable' } },
    );
    const result = await run(d, profile());
    expect(result.problems).toEqual([
      { url: `https://${host}/1.jpg`, stage: 'file', reason: 'robots_unavailable', detail: '' },
    ]);
    expect(
      SiteCrawlResultSchema.safeParse({ ...result, crawlId: '00000000-0000-4000-8000-000000000009' }).success,
    ).toBe(true);
  });

  it('strips control and format characters from an invalid_link value and cuts without splitting a pair', async () => {
    const value = `ftp://\u202Ex${'y'.repeat(192)}\u{1F600}tail`;
    const d = deps({ [`${G}/g`]: ok({ thumbnails: [value] }) });
    const result = await run(d, profile());
    const detail = result.problems[0]?.detail ?? '';
    expect(detail).not.toContain('\u202E');
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).toBe(`ftp://x${'y'.repeat(192)}`);
    const emoji = deps({ [`${G}/g`]: ok({ thumbnails: [`ftp://x${'y'.repeat(193)}\u{1F600}`] }) });
    const cut = (await run(emoji, profile())).problems[0]?.detail ?? '';
    expect(cut).toBe(`ftp://x${'y'.repeat(193)}`);
    expect(/[\uD800-\uDFFF]/.test(cut)).toBe(false);
  });

  it('records invalid_link with the page and the value cut to 200 characters', async () => {
    const long = `javascript:${'x'.repeat(300)}`;
    const d = deps({ [`${G}/g`]: ok({ thumbnails: ['ftp://x.test/a.jpg', '  ', long, '/ok.jpg'] }) });
    const result = await run(d, profile());
    expect(result.invalid).toBe(3);
    expect(result.problems).toEqual([
      { url: `${G}/g`, stage: 'link', reason: 'invalid_link', detail: 'ftp://x.test/a.jpg' },
      { url: `${G}/g`, stage: 'link', reason: 'invalid_link', detail: '' },
      { url: `${G}/g`, stage: 'link', reason: 'invalid_link', detail: long.slice(0, 200) },
    ]);
  });

  it('records off_site for pagination and detail links off the site, each once', async () => {
    const d = deps({
      [`${G}/g`]: ok({
        thumbnails: ['https://other.test/d/1', '/d/2'],
        pagination: ['https://other.test/g2', '/g?p=2'],
      }),
      [`${G}/d/2`]: ok({ file: ['/2.jpg'] }),
      [`${G}/g?p=2`]: ok({ thumbnails: ['https://other.test/d/1'], pagination: ['https://other.test/g2'] }),
    });
    const result = await run(d, profile({ pagination: '//p', file: '//img' }));
    expect(result.files).toEqual([`${G}/2.jpg`]);
    // Each distinct link off the site counts once, however often it is found.
    expect(result.offSite).toBe(2);
    expect(result.problems).toEqual([
      { url: 'https://other.test/d/1', stage: 'detail', reason: 'off_site', detail: null },
      { url: 'https://other.test/g2', stage: 'gallery', reason: 'off_site', detail: null },
    ]);
  });

  it('records filtered_text and filtered_kind for the files the filters leave out, and no duplicate or limit', async () => {
    const d = deps({
      [`${G}/g`]: ok({ thumbnails: ['/full/1.jpg', '/small/2.jpg', '/full/3.pdf', '/full/1.jpg', '/full/4.jpg'] }),
    });
    const result = await run(d, profile({ urlContains: 'full', maxFiles: 1 }));
    expect(result).toMatchObject({ files: [`${G}/full/1.jpg`], filtered: 2, duplicates: 1, truncated: 'files' });
    expect(result.problems).toEqual([
      { url: `${G}/small/2.jpg`, stage: 'file', reason: 'filtered_text', detail: null },
      { url: `${G}/full/3.pdf`, stage: 'file', reason: 'filtered_kind', detail: null },
    ]);
  });

  it(`keeps at most ${SITE_MAX_PROBLEMS} problems and counts the rest`, async () => {
    const values = Array.from({ length: 250 }, (_, i) => `ftp://x.test/${i}.jpg`);
    const d = deps({ [`${G}/g`]: ok({ thumbnails: values }) });
    const result = await run(d, profile());
    expect(result.invalid).toBe(250);
    expect(result.problems).toHaveLength(SITE_MAX_PROBLEMS);
    expect(result.problemsDropped).toBe(50);
    expect(result.problems[0]!.detail).toBe('ftp://x.test/0.jpg');
  });

  it('keeps the counters in step with the problems', async () => {
    const d = deps(
      {
        [`${G}/g`]: ok({
          thumbnails: ['/1.jpg', '/1.jpg', '/a.pdf', '/private/2.jpg', 'ftp://x.test/3.jpg'],
          pagination: ['/g?p=2'],
        }),
        [`${G}/g?p=2`]: { ok: false, reason: 'http_error', status: 500 },
      },
      { [G]: 'User-agent: *\nDisallow: /private' },
    );
    const result = await run(d, profile({ pagination: '//p' }));
    const counted = (reasons: string[]) => result.problems.filter((p) => reasons.includes(p.reason)).length;
    expect(result).toMatchObject({ pages: 1, duplicates: 1, filtered: 1, disallowed: 1, invalid: 1, pageFailures: 1 });
    expect(counted(['filtered_kind', 'filtered_text'])).toBe(result.filtered);
    expect(counted(['robots_disallowed', 'robots_unavailable'])).toBe(result.disallowed);
    expect(counted(['invalid_link'])).toBe(result.invalid);
    expect(counted(['no_thumbnails', 'no_file', 'timeout', 'left_site', 'http_error', 'load_failed'])).toBe(
      result.pageFailures,
    );
  });
});
