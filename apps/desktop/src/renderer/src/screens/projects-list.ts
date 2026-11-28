import type { ProjectSummary } from '@assetforge/contracts';
import { pagesForRows } from '../gallery';
import type { VisibleRows } from '../hooks/useVirtualRows';
import type { PagedState } from '../paged-list';

/** The rows the mounted table reported, with the list they belong to. */
export type ReportedRows = VisibleRows & { viewKey: string };

/**
 * The pages the projects screen wants: page 0 until the total is known, then those of the rows in
 * view of the displayed list, and none while the table of another list is still mounted.
 *
 * @param total the total, or null while unknown
 * @param rows the rows last reported, or null
 * @param viewKey the key of the displayed list
 * @returns the page numbers
 */
export function wantedPages(total: number | null, rows: ReportedRows | null, viewKey: string): number[] {
  if (total === null) return [0];
  if (rows !== null && rows.viewKey === viewKey) return pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total);
  return [];
}

/**
 * The reported rows after a report: the old object when nothing changed, so no render follows.
 *
 * @param old the rows reported before, or null
 * @param visible the rows now in view
 * @param viewKey the key of the displayed list
 * @returns the rows to keep
 */
export function nextRows(old: ReportedRows | null, visible: VisibleRows, viewKey: string): ReportedRows {
  return old !== null &&
    old.viewKey === viewKey &&
    old.firstRow === visible.firstRow &&
    old.lastRow === visible.lastRow &&
    old.columns === visible.columns
    ? old
    : { ...visible, viewKey };
}

/**
 * The failed page that takes the place of the whole list, while the total is unknown.
 *
 * @param state the paged list
 * @returns the first failed page, or null
 */
export function failedFirstPage(state: PagedState<ProjectSummary>): number | null {
  if (state.total !== null) return null;
  return [...state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null;
}

/**
 * Whether the displayed list was filtered by tags: its items then carry `matchedTags`.
 *
 * @param state the paged list
 * @returns true when a loaded page has matched tags
 */
export function hasMatchedTags(state: PagedState<ProjectSummary>): boolean {
  return [...state.pages.values()].some((entry) => entry.status === 'loaded' && entry.items[0]?.matchedTags !== undefined);
}
