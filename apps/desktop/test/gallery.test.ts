import { describe, expect, it } from 'vitest';
import {
  columnsForWidth,
  nextFocusIndex,
  offsetShowingIndex,
  pagesForRows,
  rowCount,
  rowItems,
} from '../src/renderer/src/gallery.js';
import { MAX_IN_FLIGHT, PAGE_SIZE } from '../src/renderer/src/paged-list.js';

describe('constants', () => {
  it('has the agreed values', () => {
    expect(PAGE_SIZE).toBe(60);
    expect(MAX_IN_FLIGHT).toBe(2);
  });
});

describe('columnsForWidth', () => {
  it('fits tiles and never drops below 1', () => {
    expect(columnsForWidth(1000, 180, 16)).toBe(5);
    expect(columnsForWidth(100, 180, 16)).toBe(1);
    expect(columnsForWidth(0, 180, 16)).toBe(1);
    expect(columnsForWidth(-50, 180, 16)).toBe(1);
    expect(columnsForWidth(Number.NaN, 180, 16)).toBe(1);
  });
});

describe('rowCount / rowItems', () => {
  it('computes rows and clamps the last row', () => {
    expect(rowCount(2000, 6)).toBe(334);
    expect(rowItems(333, 6, 2000)).toEqual({ start: 1998, end: 2000 });
    expect(rowItems(0, 6, 2000)).toEqual({ start: 0, end: 6 });
  });

  it('handles total = 0 and columns larger than total', () => {
    expect(rowCount(0, 4)).toBe(0);
    expect(rowItems(0, 4, 0)).toEqual({ start: 0, end: 0 });
    expect(rowCount(3, 10)).toBe(1);
    expect(rowItems(0, 10, 3)).toEqual({ start: 0, end: 3 });
    expect(rowItems(5, 10, 3)).toEqual({ start: 3, end: 3 });
    expect(rowItems(-1, 4, 10)).toEqual({ start: 0, end: 4 });
  });
});

describe('pagesForRows', () => {
  it('maps visible rows to pages', () => {
    expect(pagesForRows(0, 9, 4, 2000)).toEqual([0]);
    expect(pagesForRows(14, 16, 4, 2000)).toEqual([0, 1]);
    expect(pagesForRows(0, 3, 4, 10)).toEqual([0]);
  });

  it('returns nothing for empty or out-of-range input', () => {
    expect(pagesForRows(0, 5, 4, 0)).toEqual([]);
    expect(pagesForRows(100, 110, 4, 10)).toEqual([]);
    expect(pagesForRows(0, 0, 10, 3)).toEqual([0]);
  });
});

describe('nextFocusIndex', () => {
  it('moves and clamps', () => {
    expect(nextFocusIndex(5, 'ArrowDown', 4, 7)).toBe(6);
    expect(nextFocusIndex(0, 'ArrowUp', 4, 7)).toBe(0);
    expect(nextFocusIndex(0, 'ArrowRight', 4, 7)).toBe(1);
    expect(nextFocusIndex(0, 'ArrowLeft', 4, 7)).toBe(0);
    expect(nextFocusIndex(6, 'ArrowRight', 4, 7)).toBe(6);
    expect(nextFocusIndex(3, 'Home', 4, 7)).toBe(0);
    expect(nextFocusIndex(3, 'End', 4, 7)).toBe(6);
    expect(nextFocusIndex(3, 'a', 4, 7)).toBeNull();
  });

  it('returns null without items and works with columns > total', () => {
    expect(nextFocusIndex(0, 'ArrowDown', 4, 0)).toBeNull();
    expect(nextFocusIndex(0, 'End', 4, 0)).toBeNull();
    expect(nextFocusIndex(1, 'ArrowDown', 10, 3)).toBe(2);
  });
});

describe('offsetShowingIndex', () => {
  it('keeps a visible row and scrolls otherwise', () => {
    expect(offsetShowingIndex(0, 40, 4, 200, 600)).toBe(2000);
    expect(offsetShowingIndex(1900, 40, 4, 200, 600)).toBe(1900);
    expect(offsetShowingIndex(2100, 40, 4, 200, 600)).toBe(2000);
  });
});
