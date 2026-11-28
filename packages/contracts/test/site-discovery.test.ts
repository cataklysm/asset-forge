import { describe, expect, it } from 'vitest';
import { ipcContract, SaveSiteProfileSchema } from '../src/index';

const PROFILE_ID = '10000000-0000-4000-8000-000000000001';
const profile = {
  name: 'Example',
  url: 'https://example.com/gallery',
  thumbnails: '//a/@href',
  pagination: '',
  file: '',
  kinds: ['image'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};

describe('background site discovery contracts', () => {
  it('exposes durable queue and review channels rather than requiring an open dialog', () => {
    for (const channel of ['sites:enqueueCrawl', 'sites:listCrawls', 'sites:getCrawl']) {
      expect(ipcContract).toHaveProperty(channel);
    }
  });

  it('validates and retains independent extraction settings while accepting old profiles', () => {
    expect(SaveSiteProfileSchema.safeParse(profile).success).toBe(true);
    const settings = { detailConcurrency: 3, requestGapMs: 500, pageTimeoutMs: 30_000 };
    expect(SaveSiteProfileSchema.parse({ ...profile, ...settings })).toMatchObject(settings);
    expect(SaveSiteProfileSchema.safeParse({ ...profile, detailConcurrency: 0 }).success).toBe(false);
    expect(SaveSiteProfileSchema.safeParse({ ...profile, pageTimeoutMs: 1 }).success).toBe(false);
  });

  it('requires a captured destination when queueing a gallery', () => {
    const channel = (ipcContract as Record<string, { request: { safeParse(value: unknown): { success: boolean } } }>)[
      'sites:enqueueCrawl'
    ];
    expect(channel).toBeDefined();
    expect(channel!.request.safeParse({ profileId: PROFILE_ID, url: 'https://example.com/gallery' }).success).toBe(
      false,
    );
    expect(
      channel!.request.safeParse({ profileId: PROFILE_ID, url: 'https://example.com/gallery', target: null }).success,
    ).toBe(true);
  });
});
