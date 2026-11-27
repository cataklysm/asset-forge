import { useCallback, useEffect, useRef, useState } from 'react';
import type { PagedState } from '../paged-list';
import { PagedLoader } from '../paged-loader';

/**
 * Loads the pages of a list that are wanted right now, at most `MAX_IN_FLIGHT` at a time
 * (see `PagedLoader`). After a change of `key` the previous results stay in `state` while
 * `pending`, until page 0 of the new key has settled; earlier answers are ignored. `patch` and
 * `refresh` update the current key in place, without a remount (see `PagedLoader`).
 */
export function usePagedList<T extends { id: string }>(
  key: string,
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  wantedPages: readonly number[],
): {
  state: PagedState<T>;
  pending: boolean;
  retry(page: number): void;
  loadThrough(count: number): Promise<void>;
  patch(items: readonly T[]): void;
  refresh(): void;
} {
  const [version, setVersion] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const loaderRef = useRef<PagedLoader<T> | null>(null);
  loaderRef.current ??= new PagedLoader<T>(key, {
    fetchPage: (offset, limit) => fetchRef.current(offset, limit),
    onChange: () => setVersion((n) => n + 1),
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
