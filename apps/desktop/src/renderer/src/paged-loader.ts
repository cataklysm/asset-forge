import {
  acceptPage,
  dropPages,
  emptyPaged,
  markLoading,
  MAX_IN_FLIGHT,
  pagesToRequest,
  PAGE_SIZE,
  patchItems,
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
 *
 * `refresh` reloads the current key in place. Every refresh starts a new round, and the answer
 * of a request started in an earlier round is dropped (it still frees its slot). A refresh that
 * cannot run yet is queued and runs once as soon as it can.
 */
export class PagedLoader<T> {
  state: PagedState<T>;
  displayed: PagedState<T>;
  private currentKey: string;
  private generation = 0;
  private outstanding = 0;
  private wanted: readonly number[] = [];
  private throughs: Through[] = [];
  private active = false;
  private readonly maxInFlight: number;
  /** Raised by every refresh; a request remembers the round it was started in. */
  private round = 0;
  /** True from a refresh until every request of its round has settled. */
  private inRound = false;
  /** Unsettled requests started in the current round while `inRound`. */
  private roundOutstanding = 0;
  /** Pages of the current round that keep their old entry until they are requested again. */
  private readonly refetch = new Set<number>();
  /**
   * A refresh that could not run yet (inactive, a round running, page 0 of the current key not
   * settled); runs once as soon as it can. A key change clears it: the new key loads fresh.
   */
  private refreshQueued = false;

  constructor(
    key: string,
    private readonly options: PagedLoaderOptions<T>,
  ) {
    this.currentKey = key;
    this.state = emptyPaged<T>(this.epochKey());
    this.displayed = this.state;
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  }

  /** The loader's current key (without the epoch); callers compare it to drop late answers of their own reads. */
  get key(): string {
    return this.currentKey;
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
    if (key === this.currentKey) return false;
    this.currentKey = key;
    this.generation += 1;
    this.state = emptyPaged<T>(this.epochKey());
    this.wanted = [];
    this.endRound();
    this.refreshQueued = false;
    this.rejectThroughs();
    this.pump(false);
    return true;
  }

  /** While inactive nothing is requested and nothing is notified; answers are still applied. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.rejectThroughs();
    else this.runQueuedRefresh();
  }

  setWanted(pages: readonly number[]): void {
    this.wanted = pages;
    this.pump();
  }

  retry(page: number): void {
    this.commit(retryPage(this.state, page));
    this.pump();
  }

  /** Replaces loaded items that have the id of one of `items`; requests nothing. */
  patch(items: readonly (T & { id: string })[]): void {
    this.commit(patchItems(this.state as PagedState<T & { id: string }>, items));
  }

  /**
   * Reloads the current key in place: key, total and `displayed` stay, the wanted pages are
   * requested again and each keeps its old entry until its answer arrives, every other page is
   * dropped at once (page 0 is refetched when no page is wanted, also when the list is empty).
   * Asked while inactive, while a round runs, while a key change is loading or before page 0 has
   * settled, it is queued and runs once afterwards: the answer outstanding then may have been
   * read before the change that asked for the refresh.
   */
  refresh(): void {
    if (!this.canRefresh()) {
      this.refreshQueued = true;
      return;
    }
    this.refreshQueued = false;
    this.round += 1;
    this.inRound = true;
    this.roundOutstanding = 0;
    const wanted = new Set(this.candidates());
    if (wanted.size === 0) {
      wanted.add(0);
      this.refetch.add(0);
    }
    const drop: number[] = [];
    for (const [page, entry] of this.state.pages) {
      // A loading page waits for an answer of the earlier round: dropped, and requested anew.
      if (wanted.has(page) && entry.status !== 'loading') this.refetch.add(page);
      else drop.push(page);
    }
    this.commit(dropPages(this.state, drop));
    this.pump();
    this.endRoundIfSettled();
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
    return `${this.currentKey}#${this.generation}`;
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

  /** The wanted and the `loadThrough` pages, without those past the known total. */
  private candidates(): number[] {
    const { total } = this.state;
    // A wanted range can lag behind a shrunk total; pages past the end do not exist.
    const existing = total === null ? this.wanted : this.wanted.filter((p) => p * PAGE_SIZE < total);
    return [...existing, ...this.throughPages()];
  }

  private pump(notify = true): void {
    if (!this.active) return;
    const { total } = this.state;
    // Page 0 is fetched even for an empty list: it is how an empty list learns of new rows.
    if (total !== null) for (const p of this.refetch) if (p > 0 && p * PAGE_SIZE >= total) this.refetch.delete(p);
    // A refetch is requested even when its page stopped being wanted, so its round can end.
    const candidates = this.pending ? [0] : [...this.candidates(), ...this.refetch];
    const pages = pagesToRequest(this.state, candidates, this.maxInFlight, this.outstanding, this.refetch);
    if (pages.length === 0) return;
    const requestKey = this.state.key;
    const round = this.round;
    const counted = this.inRound;
    this.commit(markLoading(this.state, pages), notify);
    for (const page of pages) {
      this.outstanding += 1;
      this.refetch.delete(page);
      if (counted) this.roundOutstanding += 1;
      let promise: Promise<{ items: T[]; total: number }>;
      try {
        promise = this.options.fetchPage(page * PAGE_SIZE, PAGE_SIZE);
      } catch (e) {
        promise = Promise.reject(e);
      }
      promise.then(
        (result) =>
          this.settle(round, counted, () => acceptPage(this.state, requestKey, page, result.items, result.total)),
        () => this.settle(round, counted, () => rejectPage(this.state, requestKey, page)),
      );
    }
  }

  // Even a stale answer frees a slot, which the current epoch may be waiting for. An answer that
  // arrives while inactive is applied too, so its page does not stay "loading" for good. An
  // answer of an earlier round is dropped: a refreshed page must not be overwritten by it.
  private settle(round: number, counted: boolean, next: () => PagedState<T>): void {
    this.outstanding -= 1;
    const current = round === this.round;
    if (current && counted && this.inRound) this.roundOutstanding -= 1;
    if (current) this.commit(next());
    // A queued refresh goes first: its own pump requests the pages, so none is requested twice.
    if (!this.runQueuedRefresh()) this.pump();
    this.checkThroughs();
    this.endRoundIfSettled();
  }

  private canRefresh(): boolean {
    return this.active && !this.inRound && !this.pending && firstPageSettled(this.state);
  }

  /** Runs a queued refresh when it can run now; returns whether it did. */
  private runQueuedRefresh(): boolean {
    if (!this.refreshQueued || !this.canRefresh()) return false;
    this.refresh();
    return true;
  }

  private endRoundIfSettled(): void {
    if (!this.inRound || this.roundOutstanding > 0 || this.refetch.size > 0) return;
    this.endRound();
    this.runQueuedRefresh();
  }

  private endRound(): void {
    this.inRound = false;
    this.roundOutstanding = 0;
    this.refetch.clear();
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
