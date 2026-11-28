import {
  belongsToSite,
  SITE_MAX_PROBLEMS,
  type SiteCrawlProblemReason,
  type SiteCrawlResult,
  type SiteCrawlStage,
  type SiteProfile,
} from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError } from './errors.js';
import { fileKind } from './media-types.js';
import type { PageLoader, PageLoadResult } from './ports/page-loader.js';
import type { RobotsAnswer } from './robots-reader.js';
import { robotsAllows } from './robots.js';
import { cutValue, safeHost } from './site-crawl-problems.js';
import { normalizeDownloadUrl } from './download-url.js';

/** What a crawl needs from its host. */
export interface SiteCrawlDependencies {
  /** Loads one page and runs the expressions on it. */
  pages: PageLoader;
  /** Answers the robots.txt of an origin; rejects only once `signal` aborts. */
  robots: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
  /** Resolves after `ms`; rejects once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** One crawl: the profile, the gallery URL as typed, the cancel signal and an optional progress report. */
export interface SiteCrawlRequest {
  profile: SiteProfile;
  url: string;
  signal: AbortSignal;
  onProgress?: (progress: { pages: number; files: number }) => void;
}

/** The least time between two page loads of one crawl. */
export const PAGE_GAP_MS = 500;

/** The query names a crawl asks the page loader for. */
export const SITE_QUERY = { thumbnails: 'thumbnails', pagination: 'pagination', file: 'file' } as const;

/** The message of an invalid expression, by query name. */
const INVALID_XPATH: Readonly<Record<string, string>> = {
  [SITE_QUERY.thumbnails]: 'The thumbnail expression is not valid XPath',
  [SITE_QUERY.pagination]: 'The pagination expression is not valid XPath',
  [SITE_QUERY.file]: 'The file expression is not valid XPath',
};
/** The message for a gallery URL that is no usable URL or lies off the profile's site. */
const OFF_SITE = "This address does not belong to the profile's site";
/** The message when the gallery origin's robots.txt cannot be read. */
const ROBOTS_UNREADABLE = "The site's robots.txt could not be read";

/** Ends the crawl early with what was found so far. */
class Stop extends Error {}

/** The answer of a crawl before the host gives it an id. */
type CrawlAnswer = Omit<SiteCrawlResult, 'crawlId'>;

/** A page load that gave nothing. */
type FailedLoad = Exclude<PageLoadResult, { ok: true }>;

/** The kinds the extension rule decides at crawl time; any other URL passes and is decided at download. */
const DECIDED_KINDS = new Set(['image', 'video', 'model', 'document']);

/**
 * The final URL of a loaded page as the crawl compares pages: normalised, and only when it belongs to the site.
 *
 * @param finalUrl the main frame's URL after the load, as the page loader reported it
 * @param site the profile's site
 * @returns the normalised URL; null when it is no URL or not on the site
 */
function finalPageOf(finalUrl: string, site: string): string | null {
  let url: string;
  try {
    url = normalizeDownloadUrl(finalUrl);
  } catch {
    return null;
  }
  return belongsToSite(url, site) ? url : null;
}

/**
 * The file kind the name rule gives the last path segment of a URL.
 *
 * @param url a normalised URL
 * @returns the kind
 */
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
 *
 * @param profile the profile, for its site
 * @param url the gallery URL as typed
 * @returns the normalised gallery URL
 * @throws ValidationFailedError for an unusable or off-site URL
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

/**
 * Origin and path of a URL, the part robots rules and a redirect check look at.
 *
 * @param url a URL
 * @returns origin and path without query or fragment
 */
function originAndPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * Reads a gallery with the profile's expressions and answers the file URLs found (spec "The crawl"). Pages are
 * loaded one after another with PAGE_GAP_MS between two loads. A cancel answers what was found so far with
 * `cancelled: true`. Throws ValidationFailedError for a gallery URL off the site or an invalid expression, and
 * InvalidOperationError when the robots.txt of the gallery URL's origin cannot be read.
 *
 * @param dependencies the page loader, the robots reader and the wait
 * @param request the profile, the gallery URL, the signal and the progress report
 * @returns the files found and the counts
 * @throws ValidationFailedError, InvalidOperationError as above
 */
export async function crawlSite(dependencies: SiteCrawlDependencies, request: SiteCrawlRequest): Promise<CrawlAnswer> {
  const galleryUrl = siteGalleryUrl(request.profile, request.url);
  return new SiteCrawl(dependencies, request, galleryUrl).run();
}

/** The state of one crawl: the answer so far, what was seen and the page queue. */
class SiteCrawl {
  private readonly dependencies: SiteCrawlDependencies;
  private readonly request: SiteCrawlRequest;
  private readonly profile: SiteProfile;
  private readonly signal: AbortSignal;
  private readonly galleryUrl: string;
  private readonly answer: CrawlAnswer = {
    files: [],
    pages: 0,
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
  };
  private readonly problemKeys = new Set<string>();
  private readonly contains: string;
  private readonly robotsByOrigin = new Map<string, Promise<RobotsAnswer>>();
  private readonly seenFiles = new Set<string>();
  private readonly seenPages: Set<string>;
  /** The final URLs of redirected gallery pages: seen like a loaded page, never counted against maxPages. */
  private readonly redirectedPages = new Set<string>();
  /** Pagination targets robots refused: counted once, never against maxPages. */
  private readonly refusedPages = new Set<string>();
  private readonly seenDetails = new Set<string>();
  /** Pagination and detail links off the site: counted once each. */
  private readonly offSiteLinks = new Set<string>();
  private readonly queue: string[];
  private loads = 0;
  private readonly galleryQueries: Record<string, string>;
  private readonly detailQueries: Record<string, string>;

  /**
   * Prepares a crawl that starts at the gallery URL.
   *
   * @param dependencies the page loader, the robots reader and the wait
   * @param request the profile, the signal and the progress report
   * @param galleryUrl the normalised gallery URL
   */
  constructor(dependencies: SiteCrawlDependencies, request: SiteCrawlRequest, galleryUrl: string) {
    this.dependencies = dependencies;
    this.request = request;
    this.profile = request.profile;
    this.signal = request.signal;
    this.galleryUrl = galleryUrl;
    this.contains = this.profile.urlContains.toLowerCase();
    this.seenPages = new Set<string>([galleryUrl]);
    this.queue = [galleryUrl];
    this.galleryQueries = { [SITE_QUERY.thumbnails]: this.profile.thumbnails };
    if (this.profile.pagination !== '') this.galleryQueries[SITE_QUERY.pagination] = this.profile.pagination;
    this.detailQueries = { [SITE_QUERY.file]: this.profile.file };
  }

  /**
   * Runs the crawl; a cancel or an early stop answers what was found so far.
   *
   * @returns the answer
   */
  async run(): Promise<CrawlAnswer> {
    try {
      await this.crawl();
    } catch (error) {
      if (error instanceof Stop || this.signal.aborted) {
        this.answer.cancelled = this.signal.aborted;
        return this.answer;
      }
      throw error;
    }
    return this.answer;
  }

  /** Checks the gallery origin's robots.txt, then reads the gallery pages in queue order. */
  private async crawl(): Promise<void> {
    // The gallery origin's robots.txt must be readable; any other origin's failure only drops its URLs.
    const galleryRobots = await this.robotsOf(new URL(this.galleryUrl).origin);
    this.checkCancel();
    if (galleryRobots.kind === 'unavailable') throw new InvalidOperationError(ROBOTS_UNREADABLE);
    if (!(await this.allowed(this.galleryUrl, 'gallery'))) return;

    while (this.queue.length > 0) {
      await this.readGalleryPage(this.queue.shift()!);
    }
  }

  /**
   * Reads one gallery page: its files (directly or through detail pages), then its pagination targets.
   *
   * @param pageUrl the page
   */
  private async readGalleryPage(pageUrl: string): Promise<void> {
    const page = await this.load(pageUrl, this.galleryQueries, SITE_QUERY.thumbnails);
    if (!page.ok) {
      this.pageFailed(pageUrl, 'gallery', page);
      this.progress();
      return;
    }
    const pageBase = await this.baseOf(page, pageUrl, 'gallery');
    if (pageBase === null) {
      this.progress();
      return;
    }
    this.answer.pages++;
    const finalPage = finalPageOf(page.finalUrl, this.profile.site);
    if (finalPage !== null && !this.seenPages.has(finalPage)) this.redirectedPages.add(finalPage);

    const thumbnails = this.resolveAll(page.results[SITE_QUERY.thumbnails], pageBase);
    if (this.profile.file === '') {
      await this.addFiles(thumbnails);
    } else {
      for (const detailUrl of thumbnails) await this.readDetailPage(detailUrl);
    }

    if (this.profile.pagination !== '') {
      for (const next of this.resolveAll(page.results[SITE_QUERY.pagination], pageBase)) await this.queuePage(next);
    }
    this.progress();
  }

  /**
   * Reads one detail page a thumbnail links to, once, and takes its file URLs.
   *
   * @param detailUrl the detail page
   */
  private async readDetailPage(detailUrl: string): Promise<void> {
    if (this.seenDetails.has(detailUrl)) return;
    if (!belongsToSite(detailUrl, this.profile.site)) {
      this.leftSite(detailUrl, 'detail');
      return;
    }
    this.seenDetails.add(detailUrl);
    if (!(await this.allowed(detailUrl, 'detail'))) return;
    const detail = await this.load(detailUrl, this.detailQueries, SITE_QUERY.file);
    if (!detail.ok) {
      this.pageFailed(detailUrl, 'detail', detail);
      this.progress();
      return;
    }
    const finalDetail = finalPageOf(detail.finalUrl, this.profile.site);
    if (finalDetail !== null) this.seenDetails.add(finalDetail);
    const detailBase = await this.baseOf(detail, detailUrl, 'detail');
    if (detailBase !== null) await this.addFiles(this.resolveAll(detail.results[SITE_QUERY.file], detailBase));
    this.progress();
  }

  /**
   * Queues a pagination target once, on the site, allowed by robots and within maxPages.
   *
   * @param next the target
   */
  private async queuePage(next: string): Promise<void> {
    if (this.seenPages.has(next) || this.redirectedPages.has(next) || this.refusedPages.has(next)) return;
    if (!belongsToSite(next, this.profile.site)) {
      this.leftSite(next, 'gallery');
      return;
    }
    if (!(await this.allowed(next, 'gallery'))) {
      this.refusedPages.add(next);
      return;
    }
    if (this.seenPages.size >= this.profile.maxPages) {
      this.answer.truncated ??= 'pages';
      return;
    }
    this.seenPages.add(next);
    this.queue.push(next);
  }

  /**
   * Takes file URLs through uniqueness, urlContains, kind, robots and maxFiles (spec "The crawl", step 5).
   *
   * @param urls the resolved file URLs
   * @throws Stop once maxFiles is reached
   */
  private async addFiles(urls: readonly string[]): Promise<void> {
    for (const url of urls) {
      if (this.seenFiles.has(url)) {
        this.answer.duplicates++;
        continue;
      }
      this.seenFiles.add(url);
      if (this.contains !== '' && !url.toLowerCase().includes(this.contains)) {
        this.answer.filtered++;
        this.problem(url, 'file', 'filtered_text');
        continue;
      }
      const kind = kindOfUrl(url);
      if (DECIDED_KINDS.has(kind) && !(this.profile.kinds as readonly string[]).includes(kind)) {
        this.answer.filtered++;
        this.problem(url, 'file', 'filtered_kind');
        continue;
      }
      if (!(await this.allowed(url, 'file'))) continue;
      if (this.answer.files.length >= this.profile.maxFiles) {
        this.answer.truncated = 'files';
        throw new Stop();
      }
      this.answer.files.push(url);
    }
  }

  /**
   * Counts a pagination or detail link off the site once and records it as a problem.
   *
   * @param url the link
   * @param stage the page kind it would have been loaded as
   */
  private leftSite(url: string, stage: SiteCrawlStage): void {
    if (!this.offSiteLinks.has(url)) {
      this.offSiteLinks.add(url);
      this.answer.offSite++;
    }
    this.problem(url, stage, 'off_site');
  }

  /**
   * Records a problem once; beyond SITE_MAX_PROBLEMS it is only counted.
   *
   * @param url the URL it concerns
   * @param stage where in the crawl it happened
   * @param reason why it gave nothing
   * @param detail a host, a status or a cut value; null for none
   */
  private problem(
    url: string,
    stage: SiteCrawlStage,
    reason: SiteCrawlProblemReason,
    detail: string | null = null,
  ): void {
    const key = `${stage}\n${reason}\n${url}\n${detail ?? ''}`;
    if (this.problemKeys.has(key)) return;
    this.problemKeys.add(key);
    if (this.answer.problems.length < SITE_MAX_PROBLEMS) this.answer.problems.push({ url, stage, reason, detail });
    else this.answer.problemsDropped++;
  }

  /**
   * Ends the crawl once it is cancelled.
   *
   * @throws Stop once the signal aborted
   */
  private checkCancel(): void {
    if (this.signal.aborted) throw new Stop();
  }

  /**
   * The robots.txt of an origin, read once per crawl; a failure other than the abort answers `unavailable`.
   *
   * @param origin the origin
   * @returns the shared answer
   */
  private robotsOf(origin: string): Promise<RobotsAnswer> {
    let pending = this.robotsByOrigin.get(origin);
    if (pending === undefined) {
      pending = this.dependencies.robots(origin, this.signal).catch((): RobotsAnswer => {
        if (this.signal.aborted) throw new Stop();
        return { kind: 'unavailable' };
      });
      this.robotsByOrigin.set(origin, pending);
    }
    return pending;
  }

  /**
   * True when robots lets the crawl use `url`; otherwise counts it as disallowed and records why.
   *
   * @param url the URL
   * @param stage where in the crawl it is used
   * @returns true when allowed
   */
  private async allowed(url: string, stage: SiteCrawlStage): Promise<boolean> {
    const robots = await this.robotsOf(new URL(url).origin);
    this.checkCancel();
    if (robots.kind === 'none') return true;
    if (robots.kind === 'unavailable') {
      this.answer.disallowed++;
      this.problem(url, stage, 'robots_unavailable', safeHost(new URL(url).host));
      return false;
    }
    if (robotsAllows(robots.rules, url)) return true;
    this.answer.disallowed++;
    this.problem(url, stage, 'robots_disallowed');
    return false;
  }

  /**
   * Resolves each raw string against the page URL; what fails the URL rule counts as invalid.
   *
   * @param raw the strings an expression answered
   * @param pageUrl the URL they resolve against
   * @returns the normalised URLs
   */
  private resolveAll(raw: readonly string[] | undefined, pageUrl: string): string[] {
    const urls: string[] = [];
    for (const value of raw ?? []) {
      const text = value.trim();
      try {
        if (text === '') throw new Error('empty');
        urls.push(normalizeDownloadUrl(new URL(text, pageUrl).href));
      } catch {
        this.answer.invalid++;
        this.problem(pageUrl, 'link', 'invalid_link', cutValue(text));
      }
    }
    return urls;
  }

  /**
   * Counts a failed page and records why it gave nothing.
   *
   * @param url the page
   * @param stage gallery or detail
   * @param result the failed load
   */
  private pageFailed(url: string, stage: 'gallery' | 'detail', result: FailedLoad): void {
    this.answer.pageFailures++;
    switch (result.reason) {
      case 'no_match':
        this.problem(url, stage, stage === 'gallery' ? 'no_thumbnails' : 'no_file');
        break;
      case 'timeout':
        this.problem(url, stage, 'timeout');
        break;
      case 'left_site':
        this.problem(url, stage, 'left_site', safeHost(result.host));
        break;
      case 'http_error':
        this.problem(url, stage, 'http_error', String(result.status));
        break;
      default:
        this.problem(url, stage, 'load_failed');
    }
  }

  /**
   * Loads one page, keeping PAGE_GAP_MS after the previous load.
   *
   * @param url the page
   * @param queries the expressions by query name
   * @param waitFor the query whose match means the page is loaded
   * @returns the load result
   * @throws Stop once cancelled, ValidationFailedError for an invalid expression
   */
  private async load(url: string, queries: Record<string, string>, waitFor: string): Promise<PageLoadResult> {
    this.checkCancel();
    if (this.loads > 0) await this.dependencies.wait(PAGE_GAP_MS, this.signal);
    this.checkCancel();
    this.loads++;
    const result = await this.dependencies.pages.load(url, { queries, waitFor, signal: this.signal });
    this.checkCancel();
    if (!result.ok && result.reason === 'invalid_xpath') {
      throw new ValidationFailedError(INVALID_XPATH[result.query] ?? INVALID_XPATH[SITE_QUERY.thumbnails]!);
    }
    return result;
  }

  /**
   * The URL a loaded page's links resolve against: its document base when that is a URL on the profile's site
   * (an in-site redirect or base element), otherwise the requested URL. Answers null when the base differs from
   * the requested URL in origin or path and robots refuses it; the page then counts as disallowed.
   *
   * @param page the loaded page
   * @param requested the URL that was loaded
   * @param stage where in the crawl it was loaded
   * @returns the base URL; null when robots refuses it
   */
  private async baseOf(page: { baseUrl: string }, requested: string, stage: SiteCrawlStage): Promise<string | null> {
    let base: string;
    try {
      base = new URL(page.baseUrl).href;
    } catch {
      return requested;
    }
    if (!belongsToSite(base, this.profile.site)) return requested;
    if (originAndPath(base) !== originAndPath(requested) && !(await this.allowed(base, stage))) return null;
    return base;
  }

  /** Reports the pages read and the files found so far. */
  private progress(): void {
    this.request.onProgress?.({ pages: this.answer.pages, files: this.answer.files.length });
  }
}
