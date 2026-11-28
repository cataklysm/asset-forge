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
