import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  VIEW_STORAGE_KEY,
  filterKey,
  readView,
  writeView,
} from '../src/renderer/src/list-state.js';

const throwingStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};
const store = (data: Record<string, string>) => ({ getItem: (k: string) => data[k] ?? null });

describe('filterKey', () => {
  it('differs for different filters and matches for equal ones', () => {
    expect(filterKey({ ...NO_FILTERS, status: 'draft' })).not.toBe(filterKey(NO_FILTERS));
    expect(filterKey({ ...NO_FILTERS, status: 'draft' })).toBe(filterKey({ ...NO_FILTERS, status: 'draft' }));
  });

  it('is unambiguous when a value contains separator characters', () => {
    const joined = { ...NO_FILTERS, typeId: 'a|b' };
    const split = { ...NO_FILTERS, typeId: 'a', status: 'b' };
    expect(filterKey(joined)).not.toBe(filterKey(split));
    expect(filterKey({ ...NO_FILTERS, typeId: 'a","b' })).not.toBe(filterKey(split));
    expect(filterKey({ ...NO_FILTERS, query: 'x' })).not.toBe(filterKey({ ...NO_FILTERS, projectId: 'x' }));
  });
});

describe('view storage', () => {
  it('defaults to grid and never throws', () => {
    expect(readView(throwingStorage)).toBe('grid');
    expect(readView(null)).toBe('grid');
    expect(readView(store({}))).toBe('grid');
    expect(() => writeView(throwingStorage, 'table')).not.toThrow();
    expect(() => writeView(null, 'table')).not.toThrow();
  });

  it('reads table and rejects nonsense', () => {
    expect(readView(store({ [VIEW_STORAGE_KEY]: 'table' }))).toBe('table');
    expect(readView(store({ [VIEW_STORAGE_KEY]: 'nonsense' }))).toBe('grid');
  });

  it('writes the chosen view', () => {
    const data: Record<string, string> = {};
    writeView({ setItem: (k, v) => void (data[k] = v) }, 'table');
    expect(data[VIEW_STORAGE_KEY]).toBe('table');
  });
});
