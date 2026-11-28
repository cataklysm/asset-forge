import { belongsToSite } from '@assetforge/contracts';
import type { PageLoader, PageLoadResult } from '@assetforge/core';
import { extractionCode, readExtraction } from './site-extraction.js';

/**
 * How a page load waits: poll every `pollMs` from the moment the document is parsed, at most `settleMs` after the
 * load finished, `totalMs` in all.
 */
export interface PageTiming {
  pollMs: number;
  settleMs: number;
  totalMs: number;
}

/** The timing of the real page window (spec "The crawl"). */
export const PAGE_TIMING: PageTiming = { pollMs: 250, settleMs: 10_000, totalMs: 30_000 };

/**
 * The page window goes only where the profile's site is.
 *
 * @param url the navigation target
 * @param site the profile's site
 * @returns true when the target belongs to the site
 */
export const pageNavigationAllowed = (url: string, site: string): boolean => belongsToSite(url, site);

/** A window's page as the loader drives it. */
export interface PageView {
  /**
   * Navigates to `url`; `aborted` when another navigation replaced this one. `onParsed` is called when the
   * document of the navigation is parsed, which is usually long before the load finishes.
   */
  navigate(url: string, onParsed?: () => void): Promise<'loaded' | 'aborted' | 'failed'>;
  /** Runs `code` in the isolated world and answers its value. */
  evaluate(code: string): Promise<unknown>;
  /** The main frame's URL now, after any redirect; empty when the window is gone. */
  currentUrl(): string;
  stop(): void;
  /** Called with the target whenever a main-frame navigation or redirect off the site was refused. */
  onLeftSite(listener: (url: string) => void): void;
  /** Called with the HTTP status of every finished main-frame navigation (not called for a non-HTTP answer). */
  onResponse(listener: (status: number) => void): void;
}

/** What one load asks for: the queries, the one waited for, and the abort signal. */
type PageLoadRequest = Parameters<PageLoader['load']>[1];

/**
 * The listeners of the load that is running. The view's signals are registered once per window and forwarded to
 * whatever these hold, so a signal only ever reaches the load running when it arrives.
 */
interface ListenerSlots {
  left: ((url: string) => void) | null;
  response: ((status: number) => void) | null;
}

/**
 * Waits.
 *
 * @param ms the time to wait
 * @returns resolves after `ms`
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host the crawl answer may carry. */
const SAFE_HOST = /^[a-z0-9.\-_[\]:]{1,253}$/;

/**
 * The lower-case host of a refused target for the crawl answer.
 *
 * @param url the refused target
 * @returns the host; `''` when it cannot be read or looks odd
 */
export function leftSiteHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SAFE_HOST.test(host) ? host : '';
  } catch {
    return '';
  }
}

/**
 * A status the page loader takes from a navigation; anything else reads as no status.
 *
 * @param status the main frame's response code
 * @returns true for an integer from 100 to 999
 */
const isStatus = (status: number): boolean => Number.isInteger(status) && status >= 100 && status <= 999;

/**
 * The PageLoader of one page window (spec "The crawl", step 2, and "Diagnostics"). The poll starts when the
 * document is parsed and does not wait for the load to finish; while the load is still under way a match counts
 * only once two polls in a row saw the same number of nodes, so a list a script is still filling is not cut short.
 * Every load stops the view when it ends: a page that answered loads nothing further, and a navigation still under
 * way cannot redirect, or report leaving the site, during the next load; a left-the-site signal or a status only
 * ever reaches the load that is running when it arrives. A main-frame status of 400 or more makes a load that found
 * nothing an `http_error`; a page that matches `waitFor` is a page whatever its status.
 *
 * @param view the page of the window
 * @param site the profile's site
 * @param timing the poll interval and the time limits
 * @returns the page loader of the crawl
 */
export function createPageLoader(view: PageView, site: string, timing: PageTiming = PAGE_TIMING): PageLoader {
  const slots: ListenerSlots = { left: null, response: null };
  view.onLeftSite((target) => slots.left?.(target));
  view.onResponse((status) => slots.response?.(status));
  return { load: (url, request) => loadPage(view, slots, site, timing, url, request) };
}

/**
 * One load of the page loader: refused at once when aborted or off the site, else run by a `PageLoad`.
 *
 * @param view the page of the window
 * @param slots the listener slots of the window
 * @param site the profile's site
 * @param timing the poll interval and the time limits
 * @param url the page to load
 * @param request the queries, the one waited for, and the abort signal
 * @returns the result of the load
 */
function loadPage(
  view: PageView,
  slots: ListenerSlots,
  site: string,
  timing: PageTiming,
  url: string,
  request: PageLoadRequest,
): Promise<PageLoadResult> {
  if (request.signal.aborted) return Promise.resolve({ ok: false, reason: 'failed' });
  if (!pageNavigationAllowed(url, site))
    return Promise.resolve({ ok: false, reason: 'left_site', host: leftSiteHost(url) });
  return new PageLoad(view, slots, timing, url, request).start();
}

/**
 * The state of one page load. Every way it ends goes through `finish`, which runs once and stops the view.
 */
class PageLoad {
  private readonly view: PageView;
  private readonly slots: ListenerSlots;
  private readonly timing: PageTiming;
  private readonly url: string;
  private readonly request: PageLoadRequest;
  private readonly names: string[];
  private readonly code: string;
  /** Resolves with the result once the load finished. */
  private readonly ended: Promise<PageLoadResult>;
  private settle: (result: PageLoadResult) => void = () => {};
  private isDone = false;
  /** The document arrived (the navigation resolved); a later miss is `no_match`, not `timeout`. */
  private isLoaded = false;
  private status: number | null = null;
  /** When the navigation ended; null while the load is still under way. */
  private settledAt: number | null = null;
  private isPolling = false;

  private readonly onLeft = (target: string): void =>
    this.finish({ ok: false, reason: 'left_site', host: leftSiteHost(target) });
  private readonly onResponse = (answered: number): void => {
    if (!this.isDone && isStatus(answered)) this.status = answered;
  };
  private readonly onAbort = (): void => this.finish({ ok: false, reason: 'failed' });
  private readonly failed = (): void => this.finish({ ok: false, reason: 'failed' });

  /**
   * Prepares the load; nothing starts before `start`.
   *
   * @param view the page of the window
   * @param slots the listener slots of the window
   * @param timing the poll interval and the time limits
   * @param url the page to load
   * @param request the queries, the one waited for, and the abort signal
   */
  constructor(view: PageView, slots: ListenerSlots, timing: PageTiming, url: string, request: PageLoadRequest) {
    this.view = view;
    this.slots = slots;
    this.timing = timing;
    this.url = url;
    this.request = request;
    this.names = Object.keys(request.queries);
    this.code = extractionCode(request.queries);
    this.ended = new Promise<PageLoadResult>((resolve) => {
      this.settle = resolve;
    });
  }

  /**
   * Runs the load: takes the abort and the window's signals, starts the overall timer and the navigation, and
   * gives everything back when it ends.
   *
   * @returns the result of the load
   */
  async start(): Promise<PageLoadResult> {
    const { signal } = this.request;
    signal.addEventListener('abort', this.onAbort, { once: true });
    this.slots.left = this.onLeft;
    this.slots.response = this.onResponse;
    const overall = setTimeout(
      () => this.finish(this.missed(this.isLoaded ? 'no_match' : 'timeout')),
      this.timing.totalMs,
    );
    this.navigate().catch(this.failed);
    try {
      return await this.ended;
    } finally {
      clearTimeout(overall);
      signal.removeEventListener('abort', this.onAbort);
    }
  }

  /**
   * What a load that found nothing answers.
   *
   * @param fallback the reason when the page answered no error status
   * @returns `http_error` with the status when it was 400 or more, else `fallback`
   */
  private missed(fallback: 'no_match' | 'timeout' | 'failed'): PageLoadResult {
    return this.status !== null && this.status >= 400
      ? { ok: false, reason: 'http_error', status: this.status }
      : { ok: false, reason: fallback };
  }

  /**
   * Ends the load once: frees the slots it holds, stops the view and settles the result.
   *
   * @param result the result of the load
   */
  private finish(result: PageLoadResult): void {
    if (this.isDone) return;
    this.isDone = true;
    if (this.slots.left === this.onLeft) this.slots.left = null;
    if (this.slots.response === this.onResponse) this.slots.response = null;
    try {
      this.view.stop();
    } catch {
      // A window already gone has nothing to stop.
    }
    this.settle(result);
  }

  /**
   * Navigates and polls: the poll starts when the document is parsed, or at the latest when the navigation ended.
   *
   * @returns resolves when the navigation and the poll it started ended
   */
  private async navigate(): Promise<void> {
    const navigation = await this.view.navigate(this.url, () => {
      this.poll().catch(this.failed);
    });
    if (this.isDone) return;
    if (navigation === 'failed') {
      this.finish(this.missed('failed'));
      return;
    }
    // `aborted`: a navigation within the site replaced the first one; its page is polled the same way.
    this.settledAt = Date.now();
    await this.poll();
  }

  /**
   * Polls the page until the waited-for query matches or the load ends; runs once per load, a second call returns.
   *
   * @returns resolves when the poll ended
   */
  private async poll(): Promise<void> {
    if (this.isPolling || this.isDone) return;
    this.isPolling = true;
    this.isLoaded = true;
    /** The node counts of the last poll made while the load was still under way. */
    let seen = '';
    for (;;) {
      let raw: unknown;
      try {
        raw = await this.view.evaluate(this.code);
      } catch {
        raw = undefined; // The page was replaced meanwhile; ask again.
      }
      if (this.isDone) return;
      const counts = this.judge(raw, seen);
      if (counts === null) return;
      seen = counts;
      await sleep(this.timing.pollMs);
      if (this.isDone) return;
    }
  }

  /**
   * Judges one poll: finishes the load on an invalid query, a match that counts, or the end of the settle time.
   *
   * @param raw what the page answered; undefined when it could not be asked
   * @param seen the node counts of the last poll while the load was still under way
   * @returns the node counts to remember for the next poll; null when the load finished
   */
  private judge(raw: unknown, seen: string): string | null {
    const extraction = raw === undefined ? null : readExtraction(raw, this.names);
    if (extraction?.kind === 'invalid') {
      this.finish({ ok: false, reason: 'invalid_xpath', query: extraction.query });
      return null;
    }
    let remembered = '';
    if (extraction !== null && (extraction.counts[this.request.waitFor] ?? 0) > 0) {
      const counts = JSON.stringify(extraction.counts);
      if (this.settledAt !== null || counts === seen) {
        this.finish({
          ok: true,
          results: extraction.results,
          baseUrl: extraction.baseUrl,
          finalUrl: this.view.currentUrl(),
        });
        return null;
      }
      remembered = counts;
    }
    if (this.settledAt !== null && Date.now() >= this.settledAt + this.timing.settleMs) {
      this.finish(this.missed('no_match'));
      return null;
    }
    return remembered;
  }
}
