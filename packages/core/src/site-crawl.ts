import { belongsToSite, type SiteCrawlResult, type SiteProfile } from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError } from './errors.js';
import { fileKind } from './media-types.js';
import type { PageLoader, PageLoadResult } from './ports.js';
import { robotsAllows, type RobotsAnswer } from './robots.js';
import { normalizeDownloadUrl } from './url-import.js';

export interface SiteCrawlDeps {
  pages: PageLoader;
  /** Answers the robots.txt of an origin; rejects only once `signal` aborts. */
  robots: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
  /** Resolves after `ms`; rejects once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The least time between two page loads of one crawl. */
export const PAGE_GAP_MS = 1000;

/** The query names a crawl asks the page loader for. */
export const SITE_QUERY = { thumbnails: 'thumbnails', pagination: 'pagination', file: 'file' } as const;

const INVALID_XPATH: Readonly<Record<string, string>> = {
  [SITE_QUERY.thumbnails]: 'The thumbnail expression is not valid XPath',
  [SITE_QUERY.pagination]: 'The pagination expression is not valid XPath',
  [SITE_QUERY.file]: 'The file expression is not valid XPath',
};
const OFF_SITE = "This address does not belong to the profile's site";
const ROBOTS_UNREADABLE = "The site's robots.txt could not be read";

/** Ends the crawl early with what was found so far. */
class Stop extends Error {}

type CrawlAnswer = Omit<SiteCrawlResult, 'crawlId'>;

/** The kinds the extension rule decides at crawl time; any other URL passes and is decided at download. */
const DECIDED_KINDS = new Set(['image', 'video', 'model', 'document']);

function kindOfUrl(url: string): string {
  const path = new URL(url).pathname;
  let name = path.slice(path.lastIndexOf('/') + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw segment.
  }
  return fileKind(name);
}

/**
 * Reads a gallery with the profile's expressions and answers the file URLs found (spec "The crawl"). Pages are
 * loaded one after another with PAGE_GAP_MS between two loads. A cancel answers what was found so far with
 * `cancelled: true`. Throws ValidationFailedError for a gallery URL off the site or an invalid expression, and
 * InvalidOperationError when the robots.txt of the gallery URL's origin cannot be read.
 */
export async function crawlSite(
  deps: SiteCrawlDeps,
  r: {
    profile: SiteProfile;
    url: string;
    signal: AbortSignal;
    onProgress?: (p: { pages: number; files: number }) => void;
  },
): Promise<CrawlAnswer> {
  const { profile, signal } = r;
  let galleryUrl: string;
  try {
    galleryUrl = normalizeDownloadUrl(r.url);
  } catch {
    throw new ValidationFailedError(OFF_SITE);
  }
  if (!belongsToSite(galleryUrl, profile.site)) throw new ValidationFailedError(OFF_SITE);

  const answer: CrawlAnswer = {
    files: [],
    pages: 0,
    duplicates: 0,
    filtered: 0,
    disallowed: 0,
    invalid: 0,
    pageFailures: 0,
    truncated: null,
    cancelled: false,
  };
  const contains = profile.urlContains.toLowerCase();
  const robotsByOrigin = new Map<string, Promise<RobotsAnswer>>();
  const seenFiles = new Set<string>();
  const seenPages = new Set<string>([galleryUrl]);
  /** Pagination targets robots refused: counted once, never against maxPages. */
  const refusedPages = new Set<string>();
  const seenDetails = new Set<string>();
  const queue: string[] = [galleryUrl];
  let loads = 0;

  const checkCancel = () => {
    if (signal.aborted) throw new Stop();
  };

  const robotsOf = (origin: string): Promise<RobotsAnswer> => {
    let pending = robotsByOrigin.get(origin);
    if (pending === undefined) {
      pending = deps.robots(origin, signal).catch((): RobotsAnswer => {
        if (signal.aborted) throw new Stop();
        return { kind: 'unavailable' };
      });
      robotsByOrigin.set(origin, pending);
    }
    return pending;
  };

  const allowed = async (url: string): Promise<boolean> => {
    const robots = await robotsOf(new URL(url).origin);
    checkCancel();
    if (robots.kind === 'none') return true;
    if (robots.kind === 'unavailable') return false;
    return robotsAllows(robots.rules, url);
  };

  /** Resolves each raw string against the page URL; what fails the URL rule counts as invalid. */
  const resolveAll = (raw: readonly string[] | undefined, pageUrl: string): string[] => {
    const urls: string[] = [];
    for (const value of raw ?? []) {
      const text = value.trim();
      try {
        if (text === '') throw new Error('empty');
        urls.push(normalizeDownloadUrl(new URL(text, pageUrl).href));
      } catch {
        answer.invalid++;
      }
    }
    return urls;
  };

  const load = async (url: string, queries: Record<string, string>, waitFor: string): Promise<PageLoadResult> => {
    checkCancel();
    if (loads > 0) await deps.wait(PAGE_GAP_MS, signal);
    checkCancel();
    loads++;
    const result = await deps.pages.load(url, { queries, waitFor, signal });
    checkCancel();
    if (!result.ok && result.reason === 'invalid_xpath') {
      throw new ValidationFailedError(INVALID_XPATH[result.query] ?? INVALID_XPATH[SITE_QUERY.thumbnails]!);
    }
    return result;
  };

  const progress = () => r.onProgress?.({ pages: answer.pages, files: answer.files.length });

  /** Takes file URLs through uniqueness, urlContains, kind, robots and maxFiles (spec "The crawl", step 5). */
  const addFiles = async (urls: readonly string[]) => {
    for (const url of urls) {
      if (seenFiles.has(url)) {
        answer.duplicates++;
        continue;
      }
      seenFiles.add(url);
      if (contains !== '' && !url.toLowerCase().includes(contains)) {
        answer.filtered++;
        continue;
      }
      const kind = kindOfUrl(url);
      if (DECIDED_KINDS.has(kind) && !(profile.kinds as readonly string[]).includes(kind)) {
        answer.filtered++;
        continue;
      }
      if (!(await allowed(url))) {
        answer.disallowed++;
        continue;
      }
      if (answer.files.length >= profile.maxFiles) {
        answer.truncated = 'files';
        throw new Stop();
      }
      answer.files.push(url);
    }
  };

  const galleryQueries: Record<string, string> = { [SITE_QUERY.thumbnails]: profile.thumbnails };
  if (profile.pagination !== '') galleryQueries[SITE_QUERY.pagination] = profile.pagination;
  const detailQueries = { [SITE_QUERY.file]: profile.file };

  try {
    // The gallery origin's robots.txt must be readable; any other origin's failure only drops its URLs.
    const galleryRobots = await robotsOf(new URL(galleryUrl).origin);
    checkCancel();
    if (galleryRobots.kind === 'unavailable') throw new InvalidOperationError(ROBOTS_UNREADABLE);
    if (!(await allowed(galleryUrl))) {
      answer.disallowed++;
      return answer;
    }

    while (queue.length > 0) {
      const pageUrl = queue.shift()!;
      const page = await load(pageUrl, galleryQueries, SITE_QUERY.thumbnails);
      if (!page.ok) {
        answer.pageFailures++;
        progress();
        continue;
      }
      answer.pages++;

      const thumbnails = resolveAll(page.results[SITE_QUERY.thumbnails], pageUrl);
      if (profile.file === '') {
        await addFiles(thumbnails);
      } else {
        for (const detailUrl of thumbnails) {
          if (seenDetails.has(detailUrl) || !belongsToSite(detailUrl, profile.site)) continue;
          seenDetails.add(detailUrl);
          if (!(await allowed(detailUrl))) {
            answer.disallowed++;
            continue;
          }
          const detail = await load(detailUrl, detailQueries, SITE_QUERY.file);
          if (!detail.ok) {
            answer.pageFailures++;
            progress();
            continue;
          }
          await addFiles(resolveAll(detail.results[SITE_QUERY.file], detailUrl));
          progress();
        }
      }

      if (profile.pagination !== '') {
        for (const next of resolveAll(page.results[SITE_QUERY.pagination], pageUrl)) {
          if (seenPages.has(next) || refusedPages.has(next) || !belongsToSite(next, profile.site)) continue;
          if (!(await allowed(next))) {
            refusedPages.add(next);
            answer.disallowed++;
            continue;
          }
          if (seenPages.size >= profile.maxPages) {
            answer.truncated ??= 'pages';
            continue;
          }
          seenPages.add(next);
          queue.push(next);
        }
      }
      progress();
    }
  } catch (error) {
    if (error instanceof Stop || signal.aborted) {
      answer.cancelled = signal.aborted;
      return answer;
    }
    throw error;
  }
  return answer;
}
