import { describe, expect, it } from 'vitest';
import {
  NO_FILE_FILTERS,
  NO_FILTERS,
  NO_PROJECT_FILTERS,
  VIEW_STORAGE_KEY,
  hasFilters,
  listKey,
  readView,
  toAssetQuery,
  toFileQuery,
  toProjectQuery,
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

describe('listKey', () => {
  it('listKey is independent of tag order and toAssetQuery drops empty values', () => {
    expect(listKey({ ...NO_FILTERS, tagNames: ['b', 'a'] })).toBe(listKey({ ...NO_FILTERS, tagNames: ['a', 'b'] }));
    expect(toAssetQuery({ ...NO_FILTERS, query: 'oak', fileKind: 'image' })).toEqual({
      query: 'oak',
      fileKind: 'image',
    });
    expect(hasFilters(NO_FILE_FILTERS)).toBe(false);
  });

  it('differs for different filters and matches for equal ones', () => {
    expect(listKey({ ...NO_FILTERS, status: 'draft' })).not.toBe(listKey(NO_FILTERS));
    expect(listKey({ ...NO_FILTERS, status: 'draft' })).toBe(listKey({ ...NO_FILTERS, status: 'draft' }));
    expect(listKey(NO_FILE_FILTERS, 'inbox')).not.toBe(listKey(NO_FILE_FILTERS, 'all'));
    expect(listKey(NO_FILE_FILTERS, 'inbox')).not.toBe(listKey(NO_FILE_FILTERS));
    expect(listKey({ ...NO_FILTERS, tagNames: ['a'] })).not.toBe(listKey({ ...NO_FILTERS, tagNames: ['a', 'b'] }));
  });

  it('is independent of the order the filter fields were written in', () => {
    const reordered = { query: '', tagNames: [], kind: '', role: '' } as const;
    expect(listKey({ ...reordered, tagNames: [] })).toBe(listKey(NO_FILE_FILTERS));
  });

  it('is unambiguous when a value contains separator characters', () => {
    const joined = { ...NO_FILTERS, typeId: 'a|b' };
    const split = { ...NO_FILTERS, typeId: 'a', projectId: 'b' };
    expect(listKey(joined)).not.toBe(listKey(split));
    expect(listKey({ ...NO_FILTERS, typeId: 'a","b' })).not.toBe(listKey(split));
    expect(listKey({ ...NO_FILTERS, query: 'x' })).not.toBe(listKey({ ...NO_FILTERS, projectId: 'x' }));
    expect(listKey({ ...NO_FILTERS, tagNames: ['a,b'] })).not.toBe(listKey({ ...NO_FILTERS, tagNames: ['a', 'b'] }));
  });
});

describe('hasFilters', () => {
  it('is false for empty filters and true once any value is set', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters(NO_PROJECT_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, tagNames: ['oak'] })).toBe(true);
    expect(hasFilters({ ...NO_FILE_FILTERS, kind: 'model' })).toBe(true);
    expect(hasFilters({ ...NO_PROJECT_FILTERS, query: 'x' })).toBe(true);
    expect(hasFilters({ ...NO_PROJECT_FILTERS, query: '   ' })).toBe(false);
  });
});

describe('queries', () => {
  it('toAssetQuery passes every set value and trims the text', () => {
    expect(toAssetQuery(NO_FILTERS)).toEqual({});
    expect(toAssetQuery({ ...NO_FILTERS, query: '   ' })).toEqual({});
    expect(
      toAssetQuery({
        typeId: 't',
        status: 'draft',
        projectId: 'p',
        query: ' oak ',
        tagNames: ['bark'],
        fileRole: 'texture',
        fileKind: 'model',
      }),
    ).toEqual({
      typeId: 't',
      status: 'draft',
      projectId: 'p',
      query: 'oak',
      tagNames: ['bark'],
      fileRole: 'texture',
      fileKind: 'model',
    });
  });

  it('toFileQuery carries the scope', () => {
    expect(toFileQuery({ kind: 'inbox' }, NO_FILE_FILTERS)).toEqual({ scope: { kind: 'inbox' } });
    expect(toFileQuery({ kind: 'all' }, { query: 'x', role: 'final', kind: 'image', tagNames: ['a'] })).toEqual({
      scope: { kind: 'all' },
      query: 'x',
      role: 'final',
      kind: 'image',
      tagNames: ['a'],
    });
  });

  it('toProjectQuery drops empty values', () => {
    expect(toProjectQuery(NO_PROJECT_FILTERS)).toEqual({});
    expect(toProjectQuery({ query: '', status: 'active', tagNames: ['a'] })).toEqual({
      status: 'active',
      tagNames: ['a'],
    });
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
