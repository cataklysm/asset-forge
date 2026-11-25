import {
  acceptPage,
  emptyPaged,
  markLoading,
  MAX_IN_FLIGHT,
  pagesToRequest,
  PAGE_SIZE,
  rejectPage,
  retryPage,
  type PagedState,
} from './paged-list';

export interface PagedLoaderOptions<T> {
  fetchPage(offset: number, limit: number): Promise<{ items: T[]; total: number }>;
  /** Called after every change of `state` while active. */
  onChange(): void;
  maxInFlight?: number;
}

interface Through {
  count: number;
  resolve(): void;
  reject(reason: Error): void;
}

/**
 * Loads the wanted pages of a list, independent of React. At most `maxInFlight` requests are
 * unsettled at any time, across key changes. Every reset gets its own epoch, so a late answer
 * of an earlier epoch is dropped even when the key itself has come back (A → B → A).
 *
 * After a key change the previous results stay `displayed` until page 0 of the new key has
 * settled (loaded or failed); until then only page 0 is requested, since the total decides
 * which other pages exist.
 */
export class PagedLoader<T> {
  state: PagedState<T>;
  displayed: PagedState<T>;
  private key: string;
  private generation = 0;
  private outstanding = 0;
  private wanted: readonly number[] = [];
  private throughs: Through[] = [];
  private active = false;
  private readonly maxInFlight: number;

  constructor(
    key: string,
    private readonly options: PagedLoaderOptions<T>,
  ) {
    this.key = key;
    this.state = emptyPaged<T>(this.epochKey());
    this.displayed = this.state;
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  }

  /** True while `displayed` still shows an earlier key. */
  get pending(): boolean {
    return this.displayed.key !== this.state.key;
  }

  /**
   * Starts a new epoch when `key` differs and requests its page 0; returns whether it did.
   * Never notifies: `displayed` does not change, and the caller reads `pending` itself.
   */
  setKey(key: string): boolean {
    if (key === this.key) return false;
    this.key = key;
    this.generation += 1;
    this.state = emptyPaged<T>(this.epochKey());
    this.wanted = [];
    this.rejectThroughs();
    this.pump(false);
    return true;
  }

  /** While inactive nothing is requested and nothing is notified; answers are still applied. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.rejectThroughs();
  }

  setWanted(pages: readonly number[]): void {
    this.wanted = pages;
    this.pump();
  }

  retry(page: number): void {
    this.commit(retryPage(this.state, page));
    this.pump();
  }

  /**
   * Requests every missing page below `ceil(min(count, total) / PAGE_SIZE)`, within the
   * in-flight cap. Resolves once they have settled (failed pages included); rejects when the
   * key changes or the loader turns inactive first.
   */
  loadThrough(count: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.active) {
        reject(new Error('The list is not active.'));
        return;
      }
      this.throughs.push({ count, resolve, reject });
      this.pump();
      this.checkThroughs();
    });
  }

  private epochKey(): string {
    return `${this.key}#${this.generation}`;
  }

  private commit(next: PagedState<T>, notify = true): void {
    if (next === this.state) return;
    this.state = next;
    if (this.displayed.key === next.key || firstPageSettled(next)) this.displayed = next;
    if (notify && this.active) this.options.onChange();
  }

  /** The pages `loadThrough` still needs; until the total is known that is page 0. */
  private throughPages(): number[] {
    const { total } = this.state;
    let count = 0;
    for (const t of this.throughs) count = Math.max(count, t.count);
    if (count <= 0) return [];
    if (total === null) return [0];
    const end = Math.ceil(Math.min(count, total) / PAGE_SIZE);
    return Array.from({ length: end }, (_, i) => i);
  }

  private pump(notify = true): void {
    if (!this.active) return;
    const { total } = this.state;
    let candidates: readonly number[];
    if (this.pending) candidates = [0];
    else {
      // A wanted range can lag behind a shrunk total; pages past the end do not exist.
      const existing = total === null ? this.wanted : this.wanted.filter((p) => p * PAGE_SIZE < total);
      candidates = [...existing, ...this.throughPages()];
    }
    const pages = pagesToRequest(this.state, candidates, this.maxInFlight, this.outstanding);
    if (pages.length === 0) return;
    const requestKey = this.state.key;
    this.commit(markLoading(this.state, pages), notify);
    for (const page of pages) {
      this.outstanding += 1;
      let promise: Promise<{ items: T[]; total: number }>;
      try {
        promise = this.options.fetchPage(page * PAGE_SIZE, PAGE_SIZE);
      } catch (e) {
        promise = Promise.reject(e);
      }
      promise.then(
        (result) => this.settle(acceptPage(this.state, requestKey, page, result.items, result.total)),
        () => this.settle(rejectPage(this.state, requestKey, page)),
      );
    }
  }

  // Even a stale answer frees a slot, which the current epoch may be waiting for. An answer that
  // arrives while inactive is applied too, so its page does not stay "loading" for good.
  private settle(next: PagedState<T>): void {
    this.outstanding -= 1;
    this.commit(next);
    this.pump();
    this.checkThroughs();
  }

  private checkThroughs(): void {
    if (this.throughs.length === 0) return;
    const { total, pages } = this.state;
    const remaining: Through[] = [];
    for (const t of this.throughs) {
      let done: boolean;
      if (t.count <= 0) done = true;
      else if (total === null) done = pages.get(0)?.status === 'failed';
      else {
        const end = Math.ceil(Math.min(t.count, total) / PAGE_SIZE);
        done = true;
        for (let p = 0; p < end && done; p += 1) {
          const status = pages.get(p)?.status;
          done = status === 'loaded' || status === 'failed';
        }
      }
      if (done) t.resolve();
      else remaining.push(t);
    }
    this.throughs = remaining;
  }

  private rejectThroughs(): void {
    const throughs = this.throughs;
    this.throughs = [];
    for (const t of throughs) t.reject(new Error('The list changed before its pages were loaded.'));
  }
}

function firstPageSettled<T>(state: PagedState<T>): boolean {
  return state.total !== null || state.pages.get(0)?.status === 'failed';
}
