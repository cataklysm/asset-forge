import { pagesForRows } from './gallery';
import type { VisibleRows } from './hooks/useVirtualRows';
import type { PagedState } from './paged-list';

/** The visible rows a table reported, with the key of the list it showed. */
export type ShownRows = VisibleRows & { viewKey: string };

/**
 * The pages a virtualised list wants: page 0 until the total is known, then the pages of the visible
 * rows of the displayed list (none while another list is about to mount).
 *
 * @param total the total; null while unknown
 * @param rows the visible rows; null before the first report
 * @param viewKey the key of the displayed list
 * @returns the page numbers
 */
export function wantedPages(total: number | null, rows: ShownRows | null, viewKey: string): number[] {
  if (total === null) return [0];
  if (rows === null || rows.viewKey !== viewKey) return [];
  return pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total);
}

/**
 * The page that failed while the total is still unknown, so the list can only offer Retry.
 *
 * @param state the paged list
 * @returns the page number, or null
 */
export function failedFirstPage<T>(state: PagedState<T>): number | null {
  if (state.total !== null) return null;
  return [...state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null;
}

/**
 * The failed page that takes the place of the whole list while the total is unknown, with its failure text.
 *
 * @param state the paged list
 * @returns the first failed page with its failure text (null without one), or null
 */
export function failedFirstEntry<T>(state: PagedState<T>): { page: number; message: string | null } | null {
  if (state.total !== null) return null;
  for (const [page, entry] of state.pages) {
    if (entry.status === 'failed') return { page, message: entry.message ?? null };
  }
  return null;
}

/**
 * The `data-index` of the item that holds the focus inside an element.
 *
 * @param root the element to look in; null finds nothing
 * @returns the index, or null when the focus is not on an item inside `root`
 */
export function focusedIndex(root: HTMLElement | null): number | null {
  const active = document.activeElement;
  if (root === null || !(active instanceof Element) || !root.contains(active)) return null;
  const value = active.closest('[data-index]')?.getAttribute('data-index');
  const index = value === undefined || value === null ? NaN : Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}
