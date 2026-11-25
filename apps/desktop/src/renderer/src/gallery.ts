import { PAGE_SIZE } from './paged-list.js';

export function columnsForWidth(width: number, minTileWidth: number, gap: number): number {
  const cell = minTileWidth + gap;
  if (!Number.isFinite(width) || !Number.isFinite(cell) || cell <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / cell));
}

function safeColumns(columns: number): number {
  return Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 1;
}

export function rowCount(total: number, columns: number): number {
  if (!(total > 0)) return 0;
  return Math.ceil(total / safeColumns(columns));
}

/** `end` is exclusive. */
export function rowItems(row: number, columns: number, total: number): { start: number; end: number } {
  const cols = safeColumns(columns);
  const max = Math.max(0, total);
  const start = Math.min(Math.max(0, row) * cols, max);
  return { start, end: Math.min(start + cols, max) };
}

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
  for (let p = Math.floor(first / pageSize); p <= Math.floor(last / pageSize); p += 1) pages.push(p);
  return pages;
}

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
