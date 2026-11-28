// The texts of the shared list controls: the pager, the filter bar and the search field.

/** The name of the pager's navigation. */
export const PAGINATION_LABEL = 'Pagination';
/** The pager's button to the previous page. */
export const PREVIOUS_PAGE_LABEL = 'Previous';
/** The pager's button to the next page. */
export const NEXT_PAGE_LABEL = 'Next';
/** The filter bar's button that resets every filter. */
export const CLEAR_FILTERS_LABEL = 'Clear filters';
/** The tooltip of a search field: the shortcut that focuses it. */
export const SEARCH_SHORTCUT_TITLE = 'Ctrl+F';

/**
 * The shown range of the pager.
 *
 * @param first the first shown row, counted from 1; 0 for an empty list
 * @param last the last shown row
 * @param total the rows over all pages
 * @returns e.g. `1–50 of 120`
 */
export function pageRange(first: number, last: number, total: number): string {
  return `${first}–${last} of ${total}`;
}
