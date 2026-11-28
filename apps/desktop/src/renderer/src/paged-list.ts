// The state of an endless list as pure functions: which pages are loading, loaded or failed, which to request
// next, and the slot shown at an index.

/** The items per page. */
export const PAGE_SIZE = 60;
/** The most page requests in flight at a time. */
export const MAX_IN_FLIGHT = 2;

/** One page of the list. */
export type PageEntry<T> =
  | { status: 'loading' }
  | { status: 'loaded'; items: readonly T[] }
  | { status: 'failed' };

/** The loaded part of a list. */
export interface PagedState<T> {
  /** The list it belongs to; answers for another key are ignored. */
  key: string;
  /** The list's total; null until the first answer. */
  total: number | null;
  /** The pages by index. */
  pages: ReadonlyMap<number, PageEntry<T>>;
}

/** What is shown at one index. */
export type Slot<T> =
  | { kind: 'placeholder' }
  | { kind: 'loaded'; item: T }
  | { kind: 'failed'; page: number };

/**
 * A list with nothing loaded.
 *
 * @param key the list
 * @returns the state
 */
export function emptyPaged<T>(key: string): PagedState<T> {
  return { key, total: null, pages: new Map() };
}

/**
 * How many pages are loading.
 *
 * @param state the list
 * @returns the count
 */
function countLoading<T>(state: PagedState<T>): number {
  let count = 0;
  for (const entry of state.pages.values()) if (entry.status === 'loading') count += 1;
  return count;
}

/**
 * Pages from `wanted` that are neither loaded, loading nor failed, limited so the requests in
 * flight stay ≤ maxInFlight. `outstanding` counts every unsettled request, including those of an
 * earlier key or pages a shrunk total dropped, which the state itself no longer shows. A page in
 * `again` is requested even though the state holds it (a refetch that keeps its old entry).
 *
 * @param state the list
 * @param wanted the pages the view needs, in order of importance
 * @param maxInFlight the most requests in flight
 * @param outstanding the requests in flight
 * @param again pages to request even though the state holds them
 * @returns the pages to request now
 */
export function pagesToRequest<T>(
  state: PagedState<T>,
  wanted: readonly number[],
  maxInFlight: number = MAX_IN_FLIGHT,
  outstanding: number = 0,
  again: ReadonlySet<number> = new Set(),
): number[] {
  let free = maxInFlight - Math.max(countLoading(state), outstanding);
  const result: number[] = [];
  for (const page of wanted) {
    if (free <= 0) break;
    if ((state.pages.has(page) && !again.has(page)) || result.includes(page)) continue;
    result.push(page);
    free -= 1;
  }
  return result;
}

/**
 * Marks pages as loading; a page the state holds keeps its entry.
 *
 * @param state the list
 * @param pages the requested pages
 * @returns the new state; `state` itself when nothing changed
 */
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

/**
 * Stores an answered page and the total it came with.
 *
 * @param state the list
 * @param key the list the answer belongs to
 * @param page the page
 * @param items its items
 * @param total the list's total
 * @param pageSize the items per page
 * @returns the new state; `state` itself when `key !== state.key` (stale response)
 */
export function acceptPage<T>(
  state: PagedState<T>,
  key: string,
  page: number,
  items: readonly T[],
  total: number,
  pageSize: number = PAGE_SIZE,
): PagedState<T> {
  if (key !== state.key) return state;
  const next = new Map<number, PageEntry<T>>();
  for (const [index, entry] of state.pages) {
    // Pages that start beyond the (possibly shrunk) total no longer exist.
    if (index * pageSize < total) next.set(index, entry);
  }
  if (page * pageSize < total) next.set(page, { status: 'loaded', items });
  return { ...state, total, pages: next };
}

/**
 * Marks `page` failed; a page that starts beyond the known total does not exist and is dropped instead.
 *
 * @param state the list
 * @param key the list the failure belongs to
 * @param page the page
 * @param pageSize the items per page
 * @returns the new state; `state` itself for a stale key or a loaded page
 */
export function rejectPage<T>(
  state: PagedState<T>,
  key: string,
  page: number,
  pageSize: number = PAGE_SIZE,
): PagedState<T> {
  if (key !== state.key) return state;
  if (state.pages.get(page)?.status === 'loaded') return state;
  const next = new Map(state.pages);
  if (state.total !== null && page * pageSize >= state.total) {
    if (!next.delete(page)) return state;
  } else {
    next.set(page, { status: 'failed' });
  }
  return { ...state, pages: next };
}

/**
 * Forgets a failed page, so that it is requested again.
 *
 * @param state the list
 * @param page the page
 * @returns the new state; `state` itself when the page did not fail
 */
export function retryPage<T>(state: PagedState<T>, page: number): PagedState<T> {
  if (state.pages.get(page)?.status !== 'failed') return state;
  const next = new Map(state.pages);
  next.delete(page);
  return { ...state, pages: next };
}

/**
 * What is shown at an index.
 *
 * @param state the list
 * @param index the index
 * @param pageSize the items per page
 * @returns the loaded item, the failed page, or a placeholder
 */
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

/**
 * The slot of a failed page that carries its one retry control: the page's first slot, or the
 * first visible slot when the page begins above the viewport (so the control stays visible).
 *
 * @param page the failed page
 * @param firstVisibleIndex the first visible index
 * @param pageSize the items per page
 * @returns the index
 */
export function retryIndex(page: number, firstVisibleIndex: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(page * pageSize, firstVisibleIndex);
}

/**
 * Replaces loaded items that have the id of one of `items`.
 *
 * @param state the list
 * @param items fresh items
 * @returns the new state; `state` itself when nothing matched
 */
export function patchItems<T extends { id: string }>(state: PagedState<T>, items: readonly T[]): PagedState<T> {
  if (items.length === 0) return state;
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  let next: Map<number, PageEntry<T>> | null = null;
  for (const [page, entry] of state.pages) {
    if (entry.status !== 'loaded' || !entry.items.some((item) => byId.has(item.id))) continue;
    next ??= new Map(state.pages);
    next.set(page, { status: 'loaded', items: entry.items.map((item) => byId.get(item.id) ?? item) });
  }
  return next === null ? state : { ...state, pages: next };
}

/**
 * Removes `pages` from the state.
 *
 * @param state the list
 * @param pages the pages
 * @returns the new state; `state` itself when it held none of them
 */
export function dropPages<T>(state: PagedState<T>, pages: Iterable<number>): PagedState<T> {
  let next: Map<number, PageEntry<T>> | null = null;
  for (const page of pages) {
    if (!state.pages.has(page)) continue;
    next ??= new Map(state.pages);
    next.delete(page);
  }
  return next === null ? state : { ...state, pages: next };
}

/**
 * The distinct ids of `ids` that a loaded page holds, in the order of `ids`.
 *
 * @param state the list
 * @param ids the ids asked for
 * @returns the loaded ones
 */
export function loadedIds<T extends { id: string }>(state: PagedState<T>, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const loaded = new Set<string>();
  for (const entry of state.pages.values()) {
    if (entry.status === 'loaded') for (const item of entry.items) loaded.add(item.id);
  }
  return [...new Set(ids)].filter((id) => loaded.has(id));
}

/**
 * The loaded item with `id` and its index.
 *
 * @param state the list
 * @param id the id; null for none
 * @param pageSize the items per page
 * @returns the item and its index, or null when no loaded page holds it
 */
export function findLoaded<T extends { id: string }>(
  state: PagedState<T>,
  id: string | null,
  pageSize: number = PAGE_SIZE,
): { index: number; item: T } | null {
  if (id === null) return null;
  for (const [page, entry] of state.pages) {
    if (entry.status !== 'loaded') continue;
    const at = entry.items.findIndex((item) => item.id === id);
    if (at >= 0) return { index: page * pageSize + at, item: entry.items[at]! };
  }
  return null;
}
