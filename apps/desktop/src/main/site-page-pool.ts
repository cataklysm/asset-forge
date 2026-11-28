import type { PageLoader, PageLoadResult } from '@assetforge/core';

/** One independently navigable browser page, owned by a crawl. */
export interface CrawlPage {
  loader: PageLoader;
  close(): void;
}

/** One independently navigable page and its admission state. */
interface Slot {
  page: CrawlPage;
  busy: boolean;
}
/** A queued caller, released with null on cancellation or closure. */
interface Waiting {
  accept(slot: Slot | null): void;
}

/**
 * Creates a lazy bounded pool. Every concurrent navigation uses a different page, in the same profile session.
 *
 * @param create opens a page and reports unexpected window destruction
 * @param size the maximum number of pages
 * @param onGone called once after the complete pool closes
 * @returns the pooled page loader and its idempotent close
 */
export function createPagePool(
  create: (onGone: () => void) => CrawlPage,
  size: number,
  onGone?: () => void,
): CrawlPage {
  return new PagePool(create, size, onGone);
}

/** Independent pages with cancellable FIFO admission and one shared lifetime. */
class PagePool implements CrawlPage {
  private readonly slots: Slot[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly controller = new AbortController();
  private closed = false;
  readonly loader: PageLoader = { load: (url, request) => this.load(url, request) };

  /**
   * Opens the first page; more pages are created only for concurrent callers.
   *
   * @param create opens an independent page
   * @param size the maximum number of pages
   * @param onGone called once when the pool closes
   */
  constructor(
    private readonly create: (onGone: () => void) => CrawlPage,
    private readonly size: number,
    private readonly onGone: (() => void) | undefined,
  ) {
    this.addSlot();
  }

  /** Destroys every page and wakes queued callers without navigating them. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const waiter of this.waiting.splice(0)) waiter.accept(null);
    for (const slot of this.slots) slot.page.close();
    this.onGone?.();
  }

  /**
   * Opens another independent page only when the caller has exhausted the existing ones.
   *
   * @returns the new page slot
   */
  private addSlot(): Slot {
    const slot = { page: this.create(() => this.close()), busy: false };
    this.slots.push(slot);
    return slot;
  }

  /**
   * Loads on a reserved page and releases it even after abort, browser failure or extraction failure.
   *
   * @param url the target
   * @param request the extraction and cancellation options
   * @returns the page result
   */
  private load(url: string, request: Parameters<PageLoader['load']>[1]): Promise<PageLoadResult> {
    if (this.closed || request.signal.aborted) return Promise.resolve({ ok: false, reason: 'failed' });
    const free = this.slots.find((slot) => !slot.busy);
    if (free !== undefined) return this.run(free, url, request);
    if (this.slots.length < this.size) return this.run(this.addSlot(), url, request);
    return new Promise<Slot | null>((resolve) => {
      const waiter: Waiting = {
        accept: (slot) => {
          request.signal.removeEventListener('abort', abort);
          resolve(slot);
        },
      };
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        waiter.accept(null);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
    }).then((slot) => (slot === null ? { ok: false, reason: 'failed' } : this.run(slot, url, request)));
  }

  /**
   * Uses a slot, then passes ownership directly to the next admitted caller.
   *
   * @param slot the reserved page
   * @param url the target
   * @param request the extraction options
   * @returns the page result
   */
  private async run(slot: Slot, url: string, request: Parameters<PageLoader['load']>[1]): Promise<PageLoadResult> {
    slot.busy = true;
    try {
      if (this.closed || request.signal.aborted) return { ok: false, reason: 'failed' };
      return await slot.page.loader.load(url, {
        ...request,
        signal: AbortSignal.any([request.signal, this.controller.signal]),
      });
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) slot.busy = false;
      else next.accept(slot);
    }
  }
}
