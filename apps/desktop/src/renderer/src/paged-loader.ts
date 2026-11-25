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
  /** Called after every change of `state`. */
  onChange(): void;
  maxInFlight?: number;
}

/**
 * Loads the wanted pages of a list, independent of React. At most `maxInFlight` requests are
 * unsettled at any time, across key changes. Every reset gets its own epoch, so a late answer
 * of an earlier epoch is dropped even when the key itself has come back (A → B → A).
 */
export class PagedLoader<T> {
  state: PagedState<T>;
  private key: string;
  private generation = 0;
  private outstanding = 0;
  private wanted: readonly number[] = [];
  private active = false;
  private readonly maxInFlight: number;

  constructor(
    key: string,
    private readonly options: PagedLoaderOptions<T>,
  ) {
    this.key = key;
    this.state = emptyPaged<T>(this.epochKey());
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  }

  /** Starts from an empty state when `key` differs; returns whether it did. Never notifies. */
  setKey(key: string): boolean {
    if (key === this.key) return false;
    this.key = key;
    this.generation += 1;
    this.state = emptyPaged<T>(this.epochKey());
    this.wanted = [];
    return true;
  }

  /** While inactive nothing is requested and nothing is notified. */
  setActive(active: boolean): void {
    this.active = active;
  }

  setWanted(pages: readonly number[]): void {
    this.wanted = pages;
    this.pump();
  }

  retry(page: number): void {
    this.commit(retryPage(this.state, page));
    this.pump();
  }

  private epochKey(): string {
    return `${this.key}#${this.generation}`;
  }

  private commit(next: PagedState<T>): void {
    if (next === this.state) return;
    this.state = next;
    if (this.active) this.options.onChange();
  }

  private pump(): void {
    if (!this.active) return;
    const { total } = this.state;
    // A wanted range can lag behind a shrunk total; pages past the end do not exist.
    const existing = total === null ? this.wanted : this.wanted.filter((p) => p * PAGE_SIZE < total);
    const pages = pagesToRequest(this.state, existing, this.maxInFlight, this.outstanding);
    if (pages.length === 0) return;
    const requestKey = this.state.key;
    this.commit(markLoading(this.state, pages));
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

  // Even a stale answer frees a slot, which the current epoch may be waiting for.
  private settle(next: PagedState<T>): void {
    this.outstanding -= 1;
    if (!this.active) return;
    this.commit(next);
    this.pump();
  }
}
