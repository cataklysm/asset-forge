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
export const PAGE_TIMING: PageTiming = { pollMs: 250, settleMs: 10_000, totalMs: 30_000 };

/** The page window goes only where the profile's site is. */
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
  stop(): void;
  /** Called with the target whenever a main-frame navigation or redirect off the site was refused. */
  onLeftSite(listener: (url: string) => void): void;
  /** Called with the HTTP status of every finished main-frame navigation (not called for a non-HTTP answer). */
  onResponse(listener: (status: number) => void): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host the crawl answer may carry. */
const SAFE_HOST = /^[a-z0-9.\-_[\]:]{1,253}$/;

/** The lower-case host of a refused target for the crawl answer; `''` when it cannot be read or looks odd. */
export function leftSiteHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SAFE_HOST.test(host) ? host : '';
  } catch {
    return '';
  }
}

/** A status the page loader takes from a navigation; anything else reads as no status. */
const isStatus = (status: number): boolean => Number.isInteger(status) && status >= 100 && status <= 999;

/**
 * The PageLoader of one page window (spec "The crawl", step 2, and "Diagnostics"). The poll starts when the
 * document is parsed and does not wait for the load to finish; while the load is still under way a match counts
 * only once two polls in a row saw the same number of nodes, so a list a script is still filling is not cut short.
 * Every load stops the view when it ends: a page that answered loads nothing further, and a navigation still under
 * way cannot redirect, or report leaving the site, during the next load; a left-the-site signal or a status only
 * ever reaches the load that is running when it arrives. A main-frame status of 400 or more makes a load that found nothing an `http_error`; a page that matches
 * `waitFor` is a page whatever its status.
 */
export function createPageLoader(view: PageView, site: string, timing: PageTiming = PAGE_TIMING): PageLoader {
  let leftListener: ((url: string) => void) | null = null;
  let responseListener: ((status: number) => void) | null = null;
  view.onLeftSite((target) => leftListener?.(target));
  view.onResponse((status) => responseListener?.(status));

  return {
    async load(url, r): Promise<PageLoadResult> {
      if (r.signal.aborted) return { ok: false, reason: 'failed' };
      if (!pageNavigationAllowed(url, site)) return { ok: false, reason: 'left_site', host: leftSiteHost(url) };
      const names = Object.keys(r.queries);
      const code = extractionCode(r.queries);

      let settle: (result: PageLoadResult) => void = () => {};
      const ended = new Promise<PageLoadResult>((resolve) => {
        settle = resolve;
      });
      let done = false;
      /** The document arrived (the navigation resolved); a later miss is `no_match`, not `timeout`. */
      let loaded = false;
      let status: number | null = null;
      /** What a load that found nothing answers: the status when it was an error, else `fallback`. */
      const missed = (fallback: 'no_match' | 'timeout' | 'failed'): PageLoadResult =>
        status !== null && status >= 400 ? { ok: false, reason: 'http_error', status } : { ok: false, reason: fallback };
      const onLeft = (target: string) => finish({ ok: false, reason: 'left_site', host: leftSiteHost(target) });
      const onResponse = (answered: number) => {
        if (!done && isStatus(answered)) status = answered;
      };
      const finish = (result: PageLoadResult) => {
        if (done) return;
        done = true;
        if (leftListener === onLeft) leftListener = null;
        if (responseListener === onResponse) responseListener = null;
        try {
          view.stop();
        } catch {
          // A window already gone has nothing to stop.
        }
        settle(result);
      };
      const onAbort = () => finish({ ok: false, reason: 'failed' });
      r.signal.addEventListener('abort', onAbort, { once: true });
      leftListener = onLeft;
      responseListener = onResponse;
      const overall = setTimeout(() => finish(missed(loaded ? 'no_match' : 'timeout')), timing.totalMs);

      /** When the navigation ended; null while the load is still under way. */
      let settledAt: number | null = null;
      let polling = false;
      const poll = async () => {
        if (polling || done) return;
        polling = true;
        loaded = true;
        /** The node counts of the last poll made while the load was still under way. */
        let seen = '';
        for (;;) {
          let raw: unknown;
          try {
            raw = await view.evaluate(code);
          } catch {
            raw = undefined; // The page was replaced meanwhile; ask again.
          }
          if (done) return;
          const extraction = raw === undefined ? null : readExtraction(raw, names);
          if (extraction?.kind === 'invalid') {
            finish({ ok: false, reason: 'invalid_xpath', query: extraction.query });
            return;
          }
          if (extraction !== null && (extraction.counts[r.waitFor] ?? 0) > 0) {
            const counts = JSON.stringify(extraction.counts);
            if (settledAt !== null || counts === seen) {
              finish({ ok: true, results: extraction.results, baseUrl: extraction.baseUrl });
              return;
            }
            seen = counts;
          } else {
            seen = '';
          }
          if (settledAt !== null && Date.now() >= settledAt + timing.settleMs) {
            finish(missed('no_match'));
            return;
          }
          await sleep(timing.pollMs);
          if (done) return;
        }
      };
      const failed = () => finish({ ok: false, reason: 'failed' });
      const run = async () => {
        const navigation = await view.navigate(url, () => {
          poll().catch(failed);
        });
        if (done) return;
        if (navigation === 'failed') {
          finish(missed('failed'));
          return;
        }
        // `aborted`: a navigation within the site replaced the first one; its page is polled the same way.
        settledAt = Date.now();
        await poll();
      };
      run().catch(failed);

      try {
        return await ended;
      } finally {
        clearTimeout(overall);
        r.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
