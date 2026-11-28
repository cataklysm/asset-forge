import { InvalidOperationError } from './errors.js';

/** A source needs user action or a rate-limit pause before discovery can continue. */
export class SiteCrawlBlockedError extends InvalidOperationError {
  /**
   * Describes the refusal without exposing the requested URL.
   *
   * @param status the source's HTTP response
   */
  constructor(readonly status: 401 | 403 | 429) {
    super('The source paused URL extraction');
  }
}

/** Bounded detail workers and a single shared interval between navigation starts. */
export class CrawlSchedule {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly abortFromOwner = (): void => this.controller.abort(this.owner.reason);
  private previousStart: number | null = null;
  private startTurn = Promise.resolve();
  private work: { urls: readonly string[]; next: number; failure: unknown; read(url: string): Promise<void> } | null =
    null;

  /**
   * Links worker lifetime to the owner while permitting early stops to settle sibling workers.
   *
   * @param owner the owner's cancellation signal
   * @param concurrency the bounded number of detail workers
   * @param gap the minimum interval between starts
   * @param wait the abortable timer
   * @param now the pacing clock
   */
  constructor(
    private readonly owner: AbortSignal,
    private readonly concurrency: number,
    private readonly gap: number,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>,
    private readonly now: () => number,
  ) {
    owner.addEventListener('abort', this.abortFromOwner, { once: true });
    if (owner.aborted) this.abortFromOwner();
  }

  /** Detaches the completed crawl from its owner's signal. */
  close(): void {
    this.owner.removeEventListener('abort', this.abortFromOwner);
  }

  /** Serializes admission, leaving the page loads themselves independent. */
  async pace(): Promise<void> {
    const turn = this.startTurn.then(() => this.reserveStart());
    this.startTurn = turn.catch(() => {});
    await turn;
  }

  /**
   * Runs detail workers and settles all of them before returning or throwing the first failure.
   *
   * @param urls the discovered detail URLs
   * @param read reads one independent page
   */
  async details(urls: readonly string[], read: (url: string) => Promise<void>): Promise<void> {
    this.work = { urls, next: 0, failure: undefined, read };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, urls.length) }, () => this.readNext()));
    const failure = this.work.failure;
    this.work = null;
    if (failure !== undefined) throw failure;
    this.signal.throwIfAborted();
  }

  /** Consumes links until the batch finishes or any worker stops it. */
  private async readNext(): Promise<void> {
    const work = this.work!;
    while (work.next < work.urls.length && !this.signal.aborted) {
      try {
        await work.read(work.urls[work.next++]!);
      } catch (error) {
        work.failure ??= error;
        this.controller.abort();
      }
    }
  }

  /** Waits only for the part of the interval that has not elapsed since the last start. */
  private async reserveStart(): Promise<void> {
    this.signal.throwIfAborted();
    const remaining = this.previousStart === null ? 0 : this.gap - (this.now() - this.previousStart);
    if (remaining > 0) await this.wait(remaining, this.signal);
    this.signal.throwIfAborted();
    this.previousStart = this.now();
  }
}
