import { PAGE_SIZE } from './paged-list.js';

// The grid arithmetic of the virtualised lists: columns, rows, the pages a row range needs, arrow-key
// focus and the scroll offset that shows an item.

/**
 * How many tiles fit next to each other.
 *
 * @param width the available width
 * @param minTileWidth the narrowest a tile may be
 * @param gap the gap between tiles
 * @returns at least 1
 */
export function columnsForWidth(width: number, minTileWidth: number, gap: number): number {
  const cell = minTileWidth + gap;
  if (!Number.isFinite(width) || !Number.isFinite(cell) || cell <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / cell));
}

/**
 * A column count that can be divided by.
 *
 * @param columns the reported count
 * @returns the count rounded down, or 1 when it is not a number of at least 1
 */
function safeColumns(columns: number): number {
  return Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 1;
}

/**
 * How many rows the items fill.
 *
 * @param total the number of items
 * @param columns the items per row
 * @returns the row count; 0 for no items
 */
export function rowCount(total: number, columns: number): number {
  if (!(total > 0)) return 0;
  return Math.ceil(total / safeColumns(columns));
}

/**
 * The item indexes of one row.
 *
 * @param row the row
 * @param columns the items per row
 * @param total the number of items
 * @returns the first index and the exclusive end
 */
export function rowItems(row: number, columns: number, total: number): { start: number; end: number } {
  const cols = safeColumns(columns);
  const max = Math.max(0, total);
  const start = Math.min(Math.max(0, row) * cols, max);
  return { start, end: Math.min(start + cols, max) };
}

/**
 * The pages that hold the items of a row range.
 *
 * @param firstRow the first rendered row
 * @param lastRow the last rendered row
 * @param columns the items per row
 * @param total the number of items
 * @param pageSize the items per page
 * @returns the page indexes in ascending order
 */
export function pagesForRows(
  firstRow: number,
  lastRow: number,
  columns: number,
  total: number,
  pageSize: number = PAGE_SIZE,
): number[] {
  if (!(total > 0)) return [];
  const cols = safeColumns(columns);
  const first = Math.max(0, firstRow) * cols;
  const last = Math.min(total - 1, (lastRow + 1) * cols - 1);
  if (first > last) return [];
  const pages: number[] = [];
  for (let page = Math.floor(first / pageSize); page <= Math.floor(last / pageSize); page += 1) pages.push(page);
  return pages;
}

/**
 * The index an arrow, Home or End key moves the focus to.
 *
 * @param current the focused index
 * @param key the pressed key
 * @param columns the items per row
 * @param total the number of items
 * @returns the new index, kept within the list; null for another key or no items
 */
export function nextFocusIndex(current: number, key: string, columns: number, total: number): number | null {
  if (!(total > 0)) return null;
  const cols = safeColumns(columns);
  let target: number;
  switch (key) {
    case 'ArrowRight':
      target = current + 1;
      break;
    case 'ArrowLeft':
      target = current - 1;
      break;
    case 'ArrowDown':
      target = current + cols;
      break;
    case 'ArrowUp':
      target = current - cols;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = total - 1;
      break;
    default:
      return null;
  }
  return Math.min(Math.max(0, target), total - 1);
}

/**
 * The scroll offset that shows the row of an item.
 *
 * @param savedOffset the offset to keep when the row is fully visible there
 * @param index the item
 * @param columns the items per row
 * @param rowHeight the height of a row
 * @param viewportHeight the height of the viewport
 * @returns the saved offset, or the top of the item's row
 */
export function offsetShowingIndex(
  savedOffset: number,
  index: number,
  columns: number,
  rowHeight: number,
  viewportHeight: number,
): number {
  const top = Math.floor(Math.max(0, index) / safeColumns(columns)) * rowHeight;
  const visible = top >= savedOffset && top + rowHeight <= savedOffset + viewportHeight;
  return visible ? savedOffset : top;
}
