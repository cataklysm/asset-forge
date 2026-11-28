import { describe, expect, test } from 'vitest';
import {
  belongsToSite,
  ipcContract,
  MAX_SITE_PROFILES,
  SaveSiteProfileSchema,
  SITE_MAX_FILES,
  SITE_MAX_PAGES,
  SITE_URL_CONTAINS_MAX,
  SITE_XPATH_MAX,
  SiteCrawlProblemReasonSchema,
  SiteCrawlProgressSchema,
  SiteCrawlResultSchema,
  SiteFilterSchema,
  siteOf,
  SiteProfileSchema,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

const profile = {
  id: uuid,
  name: 'Gallery',
  site: 'example.com',
  thumbnails: '//a[@class="thumb"]',
  pagination: '',
  file: '',
  kinds: ['image', 'video'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};

describe('siteOf', () => {
  test.each([
    ['https://www.Example.com/gallery', 'example.com'],
    ['http://example.com:8080/a', 'example.com'],
    ['https://sub.example.com/', 'sub.example.com'],
    ['https://www.sub.example.com/', 'sub.example.com'],
    ['http://127.0.0.1:8080/g', '127.0.0.1'],
    ['http://[::1]:8080/g', '[::1]'],
  ])('%s → %s', (url, site) => {
    expect(siteOf(url)).toBe(site);
  });

  test.each([
    ['ftp://example.com/'],
    ['https://user:pass@example.com/'],
    ['https://user@example.com/'],
    ['not a url'],
    ['file:///C:/x'],
    ['https://example.com./'],
    ['https://www./'],
    // A single label would let every host under it belong to the site.
    ['https://localhost/'],
    ['https://intranet/'],
    ['https://www.intranet/'],
    ['https://www/'],
  ])('%s → null', (url) => {
    expect(siteOf(url)).toBeNull();
  });
});

describe('belongsToSite', () => {
  test.each([
    ['https://example.com/a', true],
    ['http://example.com/a', true],
    ['https://sub.example.com/a', true],
    ['https://a.b.example.com/a', true],
    ['https://EXAMPLE.com/a', true],
    ['https://evilexample.com/a', false],
    ['https://example.com.evil.net/a', false],
    ['https://example.com./a', false],
    ['https://sub.example.com./a', false],
    ['https://user:pass@example.com/a', false],
    ['https://user@example.com/a', false],
    ['ftp://example.com/a', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['https://other.org/a', false],
  ])('%s → %s', (url, expected) => {
    expect(belongsToSite(url, 'example.com')).toBe(expected);
  });

  test('an empty site matches nothing', () => {
    expect(belongsToSite('https://example.com/', '')).toBe(false);
  });
});

describe('site profile schemas', () => {
  test('the limits', () => {
    expect(MAX_SITE_PROFILES).toBe(50);
    expect(SITE_XPATH_MAX).toBe(1000);
    expect(SITE_URL_CONTAINS_MAX).toBe(200);
    expect(SITE_MAX_PAGES).toEqual({ min: 1, max: 200, default: 20 });
    expect(SITE_MAX_FILES).toEqual({ min: 1, max: 5000, default: 1000 });
  });

  test('a profile within the bounds parses', () => {
    expect(SiteProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      SiteProfileSchema.safeParse({
        ...profile,
        name: 'x'.repeat(60),
        thumbnails: 'x'.repeat(1000),
        pagination: 'x'.repeat(1000),
        file: 'x'.repeat(1000),
        kinds: ['image', 'video', 'model', 'document', 'other'],
        minBytes: 524288000,
        urlContains: 'x'.repeat(200),
        maxPages: 200,
        maxFiles: 5000,
      }).success,
    ).toBe(true);
    expect(SiteProfileSchema.safeParse({ ...profile, maxPages: 1, maxFiles: 1 }).success).toBe(true);
  });

  test.each([
    ['name empty', { name: '' }],
    ['name too long', { name: 'x'.repeat(61) }],
    ['thumbnails empty', { thumbnails: '' }],
    ['thumbnails too long', { thumbnails: 'x'.repeat(1001) }],
    ['pagination too long', { pagination: 'x'.repeat(1001) }],
    ['file too long', { file: 'x'.repeat(1001) }],
    ['no kind', { kinds: [] }],
    ['an unknown kind', { kinds: ['audio'] }],
    ['a repeated kind', { kinds: ['image', 'image'] }],
    ['negative minBytes', { minBytes: -1 }],
    ['minBytes over the download limit', { minBytes: 524288001 }],
    ['fractional minBytes', { minBytes: 1.5 }],
    ['urlContains too long', { urlContains: 'x'.repeat(201) }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 201', { maxPages: 201 }],
    ['maxFiles 0', { maxFiles: 0 }],
    ['maxFiles 5001', { maxFiles: 5001 }],
    ['id not a uuid', { id: 'x' }],
  ])('refuses %s', (_label, patch) => {
    expect(SiteProfileSchema.safeParse({ ...profile, ...patch }).success).toBe(false);
  });

  test('the filter', () => {
    expect(SiteFilterSchema.safeParse({ kinds: ['image'], minBytes: 0 }).success).toBe(true);
    expect(SiteFilterSchema.safeParse({ kinds: [], minBytes: 0 }).success).toBe(false);
    expect(SiteFilterSchema.safeParse({ kinds: ['image', 'image'], minBytes: 0 }).success).toBe(false);
  });

  test('saving: without id a url is required, `site` is not taken', () => {
    const { id: _id, site: _site, ...fields } = profile;
    expect(SaveSiteProfileSchema.safeParse({ ...fields, url: 'https://example.com/gallery' }).success).toBe(true);
    expect(SaveSiteProfileSchema.safeParse(fields).success).toBe(false);
    expect(SaveSiteProfileSchema.safeParse({ ...fields, id: uuid }).success).toBe(true);
    const parsed = SaveSiteProfileSchema.parse({ ...fields, id: uuid, site: 'other.org' });
    expect('site' in parsed).toBe(false);
  });

  test('crawl result and progress', () => {
    const result = {
      crawlId: uuid,
      files: ['https://example.com/a.png'],
      pages: 1,
      duplicates: 0,
      filtered: 0,
      disallowed: 0,
      invalid: 0,
      pageFailures: 0,
      truncated: null,
      cancelled: false,
      problems: [{ url: 'https://example.com/g', stage: 'gallery', reason: 'http_error', detail: '403' }],
      problemsDropped: 0,
    };
    expect(SiteCrawlResultSchema.safeParse(result).success).toBe(true);
    expect(SiteCrawlResultSchema.safeParse({ ...result, problems: undefined }).success).toBe(false);
    expect(
      SiteCrawlResultSchema.safeParse({
        ...result,
        problems: [{ url: 'x', stage: 'page', reason: 'timeout', detail: null }],
      }).success,
    ).toBe(false);
    expect(
      SiteCrawlResultSchema.safeParse({
        ...result,
        problems: [{ url: 'x', stage: 'file', reason: 'beyond_limit', detail: null }],
      }).success,
    ).toBe(false);
    expect(SiteCrawlProblemReasonSchema.options).toHaveLength(12);
    expect(SiteCrawlResultSchema.safeParse({ ...result, truncated: 'pages' }).success).toBe(true);
    expect(SiteCrawlResultSchema.safeParse({ ...result, truncated: 'files' }).success).toBe(true);
    expect(SiteCrawlResultSchema.safeParse({ ...result, truncated: 'other' }).success).toBe(false);
    expect(SiteCrawlProgressSchema.safeParse({ pages: 1, files: 2, cancelling: false }).success).toBe(true);
  });

  test('the site channels', () => {
    const channels = Object.keys(ipcContract).filter((c) => c.startsWith('sites:'));
    expect(channels).toEqual([
      'sites:list',
      'sites:save',
      'sites:delete',
      'sites:openLogin',
      'sites:openCheck',
      'sites:crawl',
      'sites:crawlProgress',
      'sites:cancelCrawl',
      'sites:import',
    ]);
    expect(ipcContract['sites:openLogin'].request.safeParse({ profileId: uuid }).success).toBe(true);
    expect(
      ipcContract['sites:openLogin'].request.safeParse({ profileId: uuid, url: 'https://example.com/' }).success,
    ).toBe(true);
    expect(ipcContract['sites:openCheck'].request.safeParse({ host: 'example.com' }).success).toBe(true);
    expect(ipcContract['sites:openCheck'].request.safeParse({ host: '' }).success).toBe(false);
    expect(
      ipcContract['sites:openCheck'].request.safeParse({ host: 'example.com', url: 'https://example.com/' }).success,
    ).toBe(false);
    expect(ipcContract['sites:crawl'].request.safeParse({ profileId: uuid }).success).toBe(false);
    expect(ipcContract['sites:import'].request.safeParse({ crawlId: uuid, target: null }).success).toBe(true);
    expect(ipcContract['sites:import'].request.safeParse({ crawlId: uuid }).success).toBe(false);
    expect(ipcContract['sites:crawlProgress'].response.safeParse(null).success).toBe(true);
  });
});
