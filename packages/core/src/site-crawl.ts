import {
  belongsToSite,
  SITE_DETAIL_CONCURRENCY,
  SITE_REQUEST_GAP_MS,
  SITE_MAX_PROBLEMS,
  type SiteCrawlProblemReason,
  type SiteCrawlResult,
  type SiteCrawlStage,
  type SiteProfile,
} from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError } from './errors.js';
import type { PageLoader, PageLoadResult } from './ports/page-loader.js';
import type { RobotsAnswer } from './robots-reader.js';
import { CrawlRobots } from './site-crawl-robots.js';
import { CrawlSchedule, SiteCrawlBlockedError } from './site-crawl-schedule.js';
export { SiteCrawlBlockedError } from './site-crawl-schedule.js';
import { cutValue, safeHost } from './site-crawl-problems.js';
import { normalizeDownloadUrl } from './download-url.js';
import { SiteCrawlState, type SiteCrawlCheckpoint } from './site-crawl-checkpoint.js';
import { DECIDED_KINDS, finalPageOf, kindOfUrl, originAndPath, siteGalleryUrl } from './site-crawl-links.js';
export { siteGalleryUrl } from './site-crawl-links.js';
export { parseSiteCrawlCheckpoint, type SiteCrawlCheckpoint } from './site-crawl-checkpoint.js';

/** What a crawl needs from its host. */
export interface SiteCrawlDependencies {
  /** Loads one page and runs the expressions on it. */
  pages: PageLoader;
  /** Answers the robots.txt of an origin; rejects only once `signal` aborts. */
  robots: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
  /** Resolves after `ms`; rejects once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Milliseconds used to pace navigation starts; defaults to Date.now. */
  now?: () => number;
}

/** One crawl: the profile, the gallery URL as typed, the cancel signal and an optional progress report. */
export interface SiteCrawlRequest {
  profile: SiteProfile;
  url: string;
  signal: AbortSignal;
  onProgress?: (progress: { pages: number; files: number }) => void;
  /** Restores the saved result and skips details that completed before interruption. */
  checkpoint?: SiteCrawlCheckpoint;
  /** Saves a detached checkpoint; calls are serialized and awaited before the crawl ends. */
  onCheckpoint?: (checkpoint: SiteCrawlCheckpoint) => void | Promise<void>;
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
/** The message when the gallery origin's robots.txt cannot be read. */
const ROBOTS_UNREADABLE = "The site's robots.txt could not be read";

/** Ends the crawl early with what was found so far. */
class Stop extends Error {}

/** The answer of a crawl before the host gives it an id. */
type CrawlAnswer = Omit<SiteCrawlResult, 'crawlId'>;

/** A page load that gave nothing. */
type FailedLoad = Exclude<PageLoadResult, { ok: true }>;

/**
 * Reads a gallery with the profile's expressions and answers the file URLs found (spec "The crawl"). Pages are
 * loaded through bounded detail workers with a shared interval between navigation starts. A cancel answers what was found so far with
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
  private readonly schedule: CrawlSchedule;
  private readonly galleryUrl: string;
  private readonly state: SiteCrawlState;
  private readonly contains: string;
  private readonly policy: CrawlRobots;
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
    this.schedule = new CrawlSchedule(
      request.signal,
      request.profile.detailConcurrency ?? SITE_DETAIL_CONCURRENCY.default,
      request.profile.requestGapMs ?? SITE_REQUEST_GAP_MS.default,
      dependencies.wait,
      dependencies.now ?? Date.now,
    );
    this.signal = this.schedule.signal;
    this.galleryUrl = galleryUrl;
    this.contains = this.profile.urlContains.toLowerCase();
    this.state = new SiteCrawlState(galleryUrl, request.checkpoint, request.onCheckpoint);
    this.policy = new CrawlRobots(dependencies.robots, this.signal, (url, stage, reason, detail) => {
      this.state.answer.disallowed++;
      this.problem(url, stage, reason, detail);
    });
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
      if (error instanceof Stop || this.request.signal.aborted) {
        this.state.answer.cancelled = this.request.signal.aborted;
        return this.state.answer;
      }
      throw error;
    } finally {
      this.schedule.close();
      await this.state.save();
    }
    return this.state.answer;
  }

  /** Checks the gallery origin's robots.txt, then reads the gallery pages in queue order. */
  private async crawl(): Promise<void> {
    // The gallery origin's robots.txt must be readable; any other origin's failure only drops its URLs.
    const galleryRobots = await this.policy.robotsOf(new URL(this.galleryUrl).origin);
    this.checkCancel();
    if (galleryRobots.kind === 'unavailable') throw new InvalidOperationError(ROBOTS_UNREADABLE);
    if (!(await this.policy.allowed(this.galleryUrl, 'gallery'))) return;

    while (this.state.queue.length > 0) {
      this.state.currentGallery = this.state.queue.shift()!;
      await this.readGalleryPage(this.state.currentGallery);
      this.state.currentGallery = null;
      await this.state.save();
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
      await this.progress();
      return;
    }
    const pageBase = await this.baseOf(page, pageUrl, 'gallery');
    if (pageBase === null) {
      await this.progress();
      return;
    }
    if (!this.state.loadedGalleries.has(pageUrl)) {
      this.state.loadedGalleries.add(pageUrl);
      this.state.answer.pages++;
    }
    const finalPage = finalPageOf(page.finalUrl, this.profile.site);
    if (finalPage !== null && !this.state.seenPages.has(finalPage)) this.state.redirectedPages.add(finalPage);

    const thumbnails = this.resolveAll(page.results[SITE_QUERY.thumbnails], pageBase);
    if (this.profile.file === '') {
      await this.addFiles(thumbnails, finalPage ?? pageUrl);
    } else {
      await this.schedule.details(thumbnails, (url) => this.readDetailPage(url));
    }

    if (this.profile.pagination !== '') {
      for (const next of this.resolveAll(page.results[SITE_QUERY.pagination], pageBase)) await this.queuePage(next);
    }
    await this.progress();
  }

  /**
   * Reads one detail page a thumbnail links to, once, and takes its file URLs.
   *
   * @param detailUrl the detail page
   */
  private async readDetailPage(detailUrl: string): Promise<void> {
    if (this.state.seenDetails.has(detailUrl) || this.state.completedDetails.has(detailUrl)) return;
    if (!belongsToSite(detailUrl, this.profile.site)) {
      this.leftSite(detailUrl, 'detail');
      return;
    }
    this.state.seenDetails.add(detailUrl);
    if (!(await this.policy.allowed(detailUrl, 'detail'))) return;
    const detail = await this.load(detailUrl, this.detailQueries, SITE_QUERY.file);
    if (!detail.ok) {
      this.pageFailed(detailUrl, 'detail', detail);
      this.state.completedDetails.add(detailUrl);
      await this.progress();
      return;
    }
    const finalDetail = finalPageOf(detail.finalUrl, this.profile.site);
    if (finalDetail !== null) {
      this.state.seenDetails.add(finalDetail);
    }
    const detailBase = await this.baseOf(detail, detailUrl, 'detail');
    if (detailBase !== null)
      await this.addFiles(this.resolveAll(detail.results[SITE_QUERY.file], detailBase), finalDetail ?? detailUrl);
    this.state.completedDetails.add(detailUrl);
    if (finalDetail !== null) this.state.completedDetails.add(finalDetail);
    await this.progress();
  }

  /**
   * Queues a pagination target once, on the site, allowed by robots and within maxPages.
   *
   * @param next the target
   */
  private async queuePage(next: string): Promise<void> {
    if (this.state.seenPages.has(next) || this.state.redirectedPages.has(next) || this.state.refusedPages.has(next))
      return;
    if (!belongsToSite(next, this.profile.site)) {
      this.leftSite(next, 'gallery');
      return;
    }
    if (!(await this.policy.allowed(next, 'gallery'))) {
      this.state.refusedPages.add(next);
      return;
    }
    if (this.state.seenPages.size >= this.profile.maxPages) {
      this.state.answer.truncated ??= 'pages';
      return;
    }
    this.state.seenPages.add(next);
    this.state.queue.push(next);
  }

  /**
   * Takes file URLs through uniqueness, urlContains, kind, robots and maxFiles (spec "The crawl", step 5).
   *
   * @param urls the resolved file URLs
   * @param sourcePage the page where the URLs were found
   * @throws Stop once maxFiles is reached
   */
  private async addFiles(urls: readonly string[], sourcePage: string): Promise<void> {
    for (const url of urls) {
      if (this.state.seenFiles.has(url)) {
        this.state.answer.duplicates++;
        continue;
      }
      if (this.contains !== '' && !url.toLowerCase().includes(this.contains)) {
        this.state.seenFiles.add(url);
        this.state.answer.filtered++;
        this.problem(url, 'file', 'filtered_text');
        continue;
      }
      const kind = kindOfUrl(url);
      if (DECIDED_KINDS.has(kind) && !(this.profile.kinds as readonly string[]).includes(kind)) {
        this.state.seenFiles.add(url);
        this.state.answer.filtered++;
        this.problem(url, 'file', 'filtered_kind');
        continue;
      }
      if (!(await this.policy.allowed(url, 'file'))) {
        this.state.seenFiles.add(url);
        continue;
      }
      if (this.state.seenFiles.has(url)) {
        this.state.answer.duplicates++;
        continue;
      }
      if (this.state.answer.files.length >= this.profile.maxFiles) {
        this.state.answer.truncated = 'files';
        throw new Stop();
      }
      this.state.seenFiles.add(url);
      this.state.answer.files.push(url);
      this.state.sourcePages[url] = sourcePage;
    }
  }

  /**
   * Counts a pagination or detail link off the site once and records it as a problem.
   *
   * @param url the link
   * @param stage the page kind it would have been loaded as
   */
  private leftSite(url: string, stage: SiteCrawlStage): void {
    if (!this.state.offSiteLinks.has(url)) {
      this.state.offSiteLinks.add(url);
      this.state.answer.offSite++;
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
    if (this.state.problemKeys.has(key)) return;
    this.state.problemKeys.add(key);
    if (this.state.answer.problems.length < SITE_MAX_PROBLEMS)
      this.state.answer.problems.push({ url, stage, reason, detail });
    else this.state.answer.problemsDropped++;
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
        this.state.answer.invalid++;
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
    this.state.answer.pageFailures++;
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
   * Loads one page, spacing starts across every concurrent worker of this crawl.
   *
   * @param url the page
   * @param queries the expressions by query name
   * @param waitFor the query whose match means the page is loaded
   * @returns the load result
   * @throws Stop once cancelled, ValidationFailedError for an invalid expression
   */
  private async load(url: string, queries: Record<string, string>, waitFor: string): Promise<PageLoadResult> {
    this.checkCancel();
    await this.schedule.pace();
    const result = await this.dependencies.pages.load(url, { queries, waitFor, signal: this.signal });
    this.checkCancel();
    if (!result.ok && result.reason === 'invalid_xpath') {
      throw new ValidationFailedError(INVALID_XPATH[result.query] ?? INVALID_XPATH[SITE_QUERY.thumbnails]!);
    }
    if (!result.ok && result.reason === 'http_error' && [401, 403, 429].includes(result.status)) {
      throw new SiteCrawlBlockedError(result.status as 401 | 403 | 429);
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
    if (originAndPath(base) !== originAndPath(requested) && !(await this.policy.allowed(base, stage))) return null;
    return base;
  }

  /** Reports the pages read and the files found so far. */
  private async progress(): Promise<void> {
    this.request.onProgress?.({ pages: this.state.answer.pages, files: this.state.answer.files.length });
    await this.state.save();
  }
}
