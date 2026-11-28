import type { SiteCrawlStage } from '@assetforge/contracts';
import type { RobotsAnswer } from './robots-reader.js';
import { robotsAllows } from './robots.js';
import { safeHost } from './site-crawl-problems.js';

/** Records a refused crawl target without exposing credentials or arbitrary error text. */
type Refused = (
  url: string,
  stage: SiteCrawlStage,
  reason: 'robots_disallowed' | 'robots_unavailable',
  detail: string | null,
) => void;

/** Shared per-origin robots reads, including across independent detail workers. */
export class CrawlRobots {
  private readonly byOrigin = new Map<string, Promise<RobotsAnswer>>();

  /**
   * Prepares the policy used by every gallery, detail and file target of a crawl.
   *
   * @param read obtains robots.txt for an origin
   * @param signal cancels policy reads together with the crawl
   * @param refused records a refused target
   */
  constructor(
    private readonly read: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>,
    private readonly signal: AbortSignal,
    private readonly refused: Refused,
  ) {}

  /**
   * Reads each origin once; concurrent workers share the pending read.
   *
   * @param origin the target's origin
   * @returns the shared robots answer
   */
  robotsOf(origin: string): Promise<RobotsAnswer> {
    let pending = this.byOrigin.get(origin);
    if (pending === undefined) {
      pending = this.read(origin, this.signal).catch((): RobotsAnswer => {
        this.signal.throwIfAborted();
        return { kind: 'unavailable' };
      });
      this.byOrigin.set(origin, pending);
    }
    return pending;
  }

  /**
   * Checks a target and records why it is refused.
   *
   * @param url the normalized target
   * @param stage where it would be used
   * @returns whether the crawl may use it
   */
  async allowed(url: string, stage: SiteCrawlStage): Promise<boolean> {
    const parsed = new URL(url);
    const robots = await this.robotsOf(parsed.origin);
    this.signal.throwIfAborted();
    if (robots.kind === 'none') return true;
    if (robots.kind === 'unavailable') {
      this.refused(url, stage, 'robots_unavailable', safeHost(parsed.host));
      return false;
    }
    if (robotsAllows(robots.rules, url)) return true;
    this.refused(url, stage, 'robots_disallowed', null);
    return false;
  }
}
