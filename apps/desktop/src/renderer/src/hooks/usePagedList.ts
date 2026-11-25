import { useCallback, useEffect, useRef, useState } from 'react';
import type { PagedState } from '../paged-list';
import { PagedLoader } from '../paged-loader';

/**
 * Loads the pages of a list that are wanted right now, at most `MAX_IN_FLIGHT` at a time
 * (see `PagedLoader`). A new `key` starts from an empty state; earlier answers are ignored.
 */
export function usePagedList<T>(
  key: string,
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  wantedPages: readonly number[],
): { state: PagedState<T>; retry(page: number): void } {
  const [version, setVersion] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const loaderRef = useRef<PagedLoader<T> | null>(null);
  loaderRef.current ??= new PagedLoader<T>(key, {
    fetchPage: (offset, limit) => fetchRef.current(offset, limit),
    onChange: () => setVersion((n) => n + 1),
  });
  const loader = loaderRef.current;
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
  return { state: loader.state, retry };
}
