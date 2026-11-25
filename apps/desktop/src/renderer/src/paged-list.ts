export const PAGE_SIZE = 60;
export const MAX_IN_FLIGHT = 2;

export type PageEntry<T> =
  | { status: 'loading' }
  | { status: 'loaded'; items: readonly T[] }
  | { status: 'failed' };

export interface PagedState<T> {
  key: string;
  total: number | null;
  pages: ReadonlyMap<number, PageEntry<T>>;
}

export type Slot<T> =
  | { kind: 'placeholder' }
  | { kind: 'loaded'; item: T }
  | { kind: 'failed'; page: number };

export function emptyPaged<T>(key: string): PagedState<T> {
  return { key, total: null, pages: new Map() };
}

function countLoading<T>(state: PagedState<T>): number {
  let n = 0;
  for (const entry of state.pages.values()) if (entry.status === 'loading') n += 1;
  return n;
}

/** Pages from `wanted` that are neither loaded, loading nor failed, limited so loading ≤ maxInFlight. */
export function pagesToRequest<T>(
  state: PagedState<T>,
  wanted: readonly number[],
  maxInFlight: number = MAX_IN_FLIGHT,
): number[] {
  let free = maxInFlight - countLoading(state);
  const result: number[] = [];
  for (const page of wanted) {
    if (free <= 0) break;
    if (state.pages.has(page) || result.includes(page)) continue;
    result.push(page);
    free -= 1;
  }
  return result;
}

export function markLoading<T>(state: PagedState<T>, pages: readonly number[]): PagedState<T> {
  const next = new Map(state.pages);
  let changed = false;
  for (const page of pages) {
    if (next.has(page)) continue;
    next.set(page, { status: 'loading' });
    changed = true;
  }
  return changed ? { ...state, pages: next } : state;
}

/** Returns `state` itself when `key !== state.key` (stale response). */
export function acceptPage<T>(
  state: PagedState<T>,
  key: string,
  page: number,
  items: readonly T[],
  total: number,
): PagedState<T> {
  if (key !== state.key) return state;
  const next = new Map<number, PageEntry<T>>();
  for (const [p, entry] of state.pages) {
    // Pages that start beyond the (possibly shrunk) total no longer exist.
    if (p * PAGE_SIZE < total) next.set(p, entry);
  }
  if (page * PAGE_SIZE < total) next.set(page, { status: 'loaded', items });
  return { ...state, total, pages: next };
}

export function rejectPage<T>(state: PagedState<T>, key: string, page: number): PagedState<T> {
  if (key !== state.key) return state;
  if (state.pages.get(page)?.status === 'loaded') return state;
  const next = new Map(state.pages);
  next.set(page, { status: 'failed' });
  return { ...state, pages: next };
}

export function retryPage<T>(state: PagedState<T>, page: number): PagedState<T> {
  if (state.pages.get(page)?.status !== 'failed') return state;
  const next = new Map(state.pages);
  next.delete(page);
  return { ...state, pages: next };
}

export function slotAt<T>(state: PagedState<T>, index: number, pageSize: number = PAGE_SIZE): Slot<T> {
  if (!Number.isInteger(index) || index < 0) return { kind: 'placeholder' };
  if (state.total !== null && index >= state.total) return { kind: 'placeholder' };
  const page = Math.floor(index / pageSize);
  const entry = state.pages.get(page);
  if (!entry || entry.status === 'loading') return { kind: 'placeholder' };
  if (entry.status === 'failed') return { kind: 'failed', page };
  const item = entry.items[index - page * pageSize];
  return item === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item };
}
