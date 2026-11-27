import {
  belongsToSite,
  SITE_MAX_PROBLEMS,
  SITE_PROBLEM_VALUE_MAX,
  type SiteCrawlProblemReason,
  type SiteCrawlResult,
  type SiteCrawlStage,
  type SiteProfile,
} from '@assetforge/contracts';
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
export const PAGE_GAP_MS = 500;

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
 * The normalised gallery URL a crawl of `url` would start from. Throws ValidationFailedError with the fixed
 * off-site message for anything that is no usable URL or does not belong to the profile's site, so a caller can
 * refuse it before any page window opens.
 */
export function siteGalleryUrl(profile: Pick<SiteProfile, 'site'>, url: string): string {
  let galleryUrl: string;
  try {
    galleryUrl = normalizeDownloadUrl(url);
  } catch {
    throw new ValidationFailedError(OFF_SITE);
  }
  if (!belongsToSite(galleryUrl, profile.site)) throw new ValidationFailedError(OFF_SITE);
  return galleryUrl;
}

/** Origin and path of a URL, the part robots rules and a redirect check look at. */
function originAndPath(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/**
 * Reads a gallery with the profile's expressions and answers the file URLs found (spec "The crawl"). Pages are
 * loaded one after another with PAGE_GAP_MS between two loads. A cancel answers what was found so far with
 * `cancelled: true`. Throws ValidationFailedError for a gallery URL off the site or an invalid expression, and
 * InvalidOperationError when the robots.txt of the gallery URL's origin cannot be read.
 */
/** A host (with an optional port) the crawl answer may carry; '' when it is too long or looks odd. */
const SAFE_HOST = /^[a-z0-9.\-_[\]:]{1,253}$/;
function safeHost(host: string): string {
  const lower = host.toLowerCase();
  return SAFE_HOST.test(lower) ? lower : '';
}

/** A page-controlled value for the answer: control and format characters removed, cut without splitting a pair. */
function cutValue(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '');
  let out = '';
  for (const ch of clean) {
    if (out.length + ch.length > SITE_PROBLEM_VALUE_MAX) break;
    out += ch;
  }
  return out;
}

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
  const galleryUrl = siteGalleryUrl(profile, r.url);

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
    problems: [],
    problemsDropped: 0,
  };
  const problemKeys = new Set<string>();
  /** Records a problem once; beyond SITE_MAX_PROBLEMS it is only counted. */
  const problem = (url: string, stage: SiteCrawlStage, reason: SiteCrawlProblemReason, detail: string | null = null) => {
    const key = `${stage}\n${reason}\n${url}\n${detail ?? ''}`;
    if (problemKeys.has(key)) return;
    problemKeys.add(key);
    if (answer.problems.length < SITE_MAX_PROBLEMS) answer.problems.push({ url, stage, reason, detail });
    else answer.problemsDropped++;
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

  /** True when robots lets the crawl use `url`; otherwise counts it as disallowed and records why. */
  const allowed = async (url: string, stage: SiteCrawlStage): Promise<boolean> => {
    const robots = await robotsOf(new URL(url).origin);
    checkCancel();
    if (robots.kind === 'none') return true;
    if (robots.kind === 'unavailable') {
      answer.disallowed++;
      problem(url, stage, 'robots_unavailable', safeHost(new URL(url).host));
      return false;
    }
    if (robotsAllows(robots.rules, url)) return true;
    answer.disallowed++;
    problem(url, stage, 'robots_disallowed');
    return false;
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
        problem(pageUrl, 'link', 'invalid_link', cutValue(text));
      }
    }
    return urls;
  };

  /** Counts a failed page and records why it gave nothing. */
  const pageFailed = (url: string, stage: 'gallery' | 'detail', result: Exclude<PageLoadResult, { ok: true }>) => {
    answer.pageFailures++;
    switch (result.reason) {
      case 'no_match':
        problem(url, stage, stage === 'gallery' ? 'no_thumbnails' : 'no_file');
        break;
      case 'timeout':
        problem(url, stage, 'timeout');
        break;
      case 'left_site':
        problem(url, stage, 'left_site', safeHost(result.host));
        break;
      case 'http_error':
        problem(url, stage, 'http_error', String(result.status));
        break;
      default:
        problem(url, stage, 'load_failed');
    }
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

  /**
   * The URL a loaded page's links resolve against: its document base when that is a URL on the profile's site
   * (an in-site redirect or base element), otherwise the requested URL. Answers null when the base differs from
   * the requested URL in origin or path and robots refuses it; the page then counts as disallowed.
   */
  const baseOf = async (page: { baseUrl: string }, requested: string, stage: SiteCrawlStage): Promise<string | null> => {
    let base: string;
    try {
      base = new URL(page.baseUrl).href;
    } catch {
      return requested;
    }
    if (!belongsToSite(base, profile.site)) return requested;
    if (originAndPath(base) !== originAndPath(requested) && !(await allowed(base, stage))) return null;
    return base;
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
        problem(url, 'file', 'filtered_text');
        continue;
      }
      const kind = kindOfUrl(url);
      if (DECIDED_KINDS.has(kind) && !(profile.kinds as readonly string[]).includes(kind)) {
        answer.filtered++;
        problem(url, 'file', 'filtered_kind');
        continue;
      }
      if (!(await allowed(url, 'file'))) continue;
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
    if (!(await allowed(galleryUrl, 'gallery'))) return answer;

    while (queue.length > 0) {
      const pageUrl = queue.shift()!;
      const page = await load(pageUrl, galleryQueries, SITE_QUERY.thumbnails);
      if (!page.ok) {
        pageFailed(pageUrl, 'gallery', page);
        progress();
        continue;
      }
      const pageBase = await baseOf(page, pageUrl, 'gallery');
      if (pageBase === null) {
        progress();
        continue;
      }
      answer.pages++;

      const thumbnails = resolveAll(page.results[SITE_QUERY.thumbnails], pageBase);
      if (profile.file === '') {
        await addFiles(thumbnails);
      } else {
        for (const detailUrl of thumbnails) {
          if (seenDetails.has(detailUrl)) continue;
          if (!belongsToSite(detailUrl, profile.site)) {
            problem(detailUrl, 'detail', 'off_site');
            continue;
          }
          seenDetails.add(detailUrl);
          if (!(await allowed(detailUrl, 'detail'))) continue;
          const detail = await load(detailUrl, detailQueries, SITE_QUERY.file);
          if (!detail.ok) {
            pageFailed(detailUrl, 'detail', detail);
            progress();
            continue;
          }
          const detailBase = await baseOf(detail, detailUrl, 'detail');
          if (detailBase !== null) await addFiles(resolveAll(detail.results[SITE_QUERY.file], detailBase));
          progress();
        }
      }

      if (profile.pagination !== '') {
        for (const next of resolveAll(page.results[SITE_QUERY.pagination], pageBase)) {
          if (seenPages.has(next) || refusedPages.has(next)) continue;
          if (!belongsToSite(next, profile.site)) {
            problem(next, 'gallery', 'off_site');
            continue;
          }
          if (!(await allowed(next, 'gallery'))) {
            refusedPages.add(next);
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
