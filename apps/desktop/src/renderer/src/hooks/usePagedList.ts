import { useCallback, useEffect, useRef, useState } from 'react';
import type { PagedState } from '../paged-list';
import { PagedLoader } from '../paged-loader';

// The React side of `PagedLoader`: one loader per mounted list, re-rendered on every change of its state.

/** A paged list as `usePagedList` offers it. */
export interface PagedList<T> {
  /** The displayed pages and total. */
  state: PagedState<T>;
  /** True while a new key loads and the previous results are still shown. */
  pending: boolean;
  /** Requests a failed page again. */
  retry(page: number): void;
  /** Loads every page up to `count` items; rejects when the list changes or unmounts first. */
  loadThrough(count: number): Promise<void>;
  /** Replaces loaded records by fresh ones with the same id. */
  patch(items: readonly T[]): void;
  /** Reads the displayed pages of the current key again. */
  refresh(): void;
}

/**
 * Loads the pages of a list that are wanted right now, at most `MAX_IN_FLIGHT` at a time
 * (see `PagedLoader`). After a change of `key` the previous results stay in `state` while
 * `pending`, until page 0 of the new key has settled; earlier answers are ignored. `patch` and
 * `refresh` update the current key in place, without a remount (see `PagedLoader`).
 *
 * @param key identifies the list; a new key starts loading it
 * @param fetchPage reads one page; the latest one is used
 * @param wantedPages the pages to keep loaded
 * @returns the displayed list and its actions
 */
export function usePagedList<T extends { id: string }>(
  key: string,
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  wantedPages: readonly number[],
): PagedList<T> {
  const [version, setVersion] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const loaderRef = useRef<PagedLoader<T> | null>(null);
  loaderRef.current ??= new PagedLoader<T>(key, {
    fetchPage: (offset, limit) => fetchRef.current(offset, limit),
    onChange: () => setVersion((count) => count + 1),
  });
  const loader = loaderRef.current;
  // A new key requests its page 0 at once, through `fetchRef`, which already holds this render's fetcher.
  loader.setKey(key);

  // Inactive after unmount: no requests, no state updates.
  useEffect(() => {
    loader.setActive(true);
    return () => loader.setActive(false);
  }, [loader]);

  const wantedKey = wantedPages.join(',');
  useEffect(() => {
    loader.setWanted(wantedPages);
    // `wantedKey` stands for `wantedPages`; `version` re-checks after every change of the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, wantedKey, version]);

  const retry = useCallback((page: number) => loader.retry(page), [loader]);
  const loadThrough = useCallback((count: number) => loader.loadThrough(count), [loader]);
  const patch = useCallback((items: readonly T[]) => loader.patch(items), [loader]);
  const refresh = useCallback(() => loader.refresh(), [loader]);
  return { state: loader.displayed, pending: loader.pending, retry, loadThrough, patch, refresh };
}
