import type { FileTarget, SiteCrawlTask, SiteProfile } from '@assetforge/contracts';

/** A saved result for testing the surrounding asset/inbox screens independently of the crawler. */
export function readySiteCrawl(profile: SiteProfile, target: FileTarget | null = null): SiteCrawlTask {
  const crawlId = '33333333-3333-4333-8333-333333333333';
  const url = 'https://example.com/a.png';
  return {
    crawlId,
    jobId: crawlId,
    profileId: profile.id,
    profileName: profile.name,
    site: profile.site,
    galleryUrl: 'https://example.com/g',
    target,
    targetAssetName: null,
    createdAt: '2026-11-28T12:00:00.000Z',
    updatedAt: '2026-11-28T12:00:00.000Z',
    status: 'ready',
    errorCode: null,
    errorMessage: null,
    progress: { pages: 1, files: 1, cancelling: false },
    result: {
      crawlId,
      files: [url],
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
    },
    candidates: [{ url, sourcePageUrl: 'https://example.com/g', expectedName: 'a.png', alreadyPresent: false }],
  };
}
