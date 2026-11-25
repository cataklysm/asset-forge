import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptPage,
  emptyPaged,
  markLoading,
  pagesToRequest,
  PAGE_SIZE,
  rejectPage,
  retryPage,
  type PagedState,
} from '../paged-list';

/**
 * Loads the pages of a list that are wanted right now, at most `MAX_IN_FLIGHT` at a time.
 * A new `key` starts from an empty state; responses for an older key are ignored.
 */
export function usePagedList<T>(
  key: string,
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  wantedPages: readonly number[],
): { state: PagedState<T>; retry(page: number): void } {
  // The ref is the source of truth so that two effect runs before a re-render (StrictMode)
  // never request the same page twice; the counter only triggers re-renders.
  const stateRef = useRef<PagedState<T>>(emptyPaged<T>(key));
  if (stateRef.current.key !== key) stateRef.current = emptyPaged<T>(key);
  const [version, setVersion] = useState(0);
  const mounted = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((change: (state: PagedState<T>) => PagedState<T>) => {
    const next = change(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    if (mounted.current) setVersion((n) => n + 1);
  }, []);

  const wantedKey = wantedPages.join(',');
  useEffect(() => {
    const requestKey = stateRef.current.key;
    const total = stateRef.current.total;
    // A wanted range can lag one render behind a shrunk total; pages past the end do not exist.
    const existing = total === null ? wantedPages : wantedPages.filter((p) => p * PAGE_SIZE < total);
    const pages = pagesToRequest(stateRef.current, existing);
    if (pages.length === 0) return;
    update((state) => markLoading(state, pages));
    for (const page of pages) {
      let promise: Promise<{ items: T[]; total: number }>;
      try {
        promise = fetchRef.current(page * PAGE_SIZE, PAGE_SIZE);
      } catch (e) {
        promise = Promise.reject(e);
      }
      promise.then(
        (result) => {
          if (mounted.current) update((state) => acceptPage(state, requestKey, page, result.items, result.total));
        },
        () => {
          if (mounted.current) update((state) => rejectPage(state, requestKey, page));
        },
      );
    }
    // `wantedKey` stands for `wantedPages`; `version` re-checks after every change of the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantedKey, version, update]);

  const retry = useCallback((page: number) => update((state) => retryPage(state, page)), [update]);
  return { state: stateRef.current, retry };
}
