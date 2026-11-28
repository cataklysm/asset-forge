import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE,
  acceptPage,
  emptyPaged,
  markLoading,
  pagesToRequest,
  loadedIds,
  patchItems,
  rejectPage,
  retryIndex,
  retryPage,
  slotAt,
} from '../src/renderer/src/paged-list.js';

const items = (page: number, n = PAGE_SIZE) => Array.from({ length: n }, (_, i) => page * PAGE_SIZE + i);
const stateWithLoading = (pages: number[]) => markLoading(emptyPaged<number>('k'), pages);
const stateWithLoaded = (pages: number[]) =>
  pages.reduce((s, p) => acceptPage(s, 'k', p, items(p), 2000), emptyPaged<number>('k'));

describe('pagesToRequest', () => {
  it('counts outstanding requests the state does not show against the cap', () => {
    expect(pagesToRequest(emptyPaged<number>('k'), [0, 1], 2, 2)).toEqual([]);
    expect(pagesToRequest(emptyPaged<number>('k'), [0, 1], 2, 1)).toEqual([0]);
    expect(pagesToRequest(stateWithLoading([3]), [4, 5], 2, 0)).toEqual([4]);
  });

  it('respects the in-flight limit', () => {
    expect(pagesToRequest(stateWithLoading([3]), [3, 4, 5, 6])).toEqual([4]);
    expect(pagesToRequest(stateWithLoading([3, 4]), [5])).toEqual([]);
    expect(pagesToRequest(emptyPaged<number>('k'), [0, 1, 2])).toEqual([0, 1]);
  });

  it('skips loaded and failed pages and duplicates', () => {
    expect(pagesToRequest(stateWithLoaded([0]), [0, 1])).toEqual([1]);
    expect(pagesToRequest(rejectPage(emptyPaged<number>('k'), 'k', 1), [1])).toEqual([]);
    expect(pagesToRequest(emptyPaged<number>('k'), [2, 2])).toEqual([2]);
  });

  it('requests a retried page again', () => {
    const failed = rejectPage(emptyPaged<number>('k'), 'k', 1);
    expect(pagesToRequest(retryPage(failed, 1), [1])).toEqual([1]);
  });
});

describe('markLoading', () => {
  it('does not overwrite loaded or failed pages and does not mutate', () => {
    const loaded = stateWithLoaded([0]);
    expect(markLoading(loaded, [0])).toBe(loaded);
    const failed = rejectPage(emptyPaged<number>('k'), 'k', 1);
    expect(markLoading(failed, [1])).toBe(failed);
    const empty = emptyPaged<number>('k');
    const next = markLoading(empty, [2]);
    expect(empty.pages.size).toBe(0);
    expect(next.pages.get(2)).toEqual({ status: 'loading' });
  });
});

describe('acceptPage', () => {
  it('ignores stale responses', () => {
    const state = stateWithLoading([0]);
    expect(acceptPage(state, 'old-key', 0, items(0), 10)).toBe(state);
  });

  it('stores items and total without mutating the input', () => {
    const state = stateWithLoading([0]);
    const next = acceptPage(state, 'k', 0, items(0), 2000);
    expect(next.total).toBe(2000);
    expect(state.total).toBeNull();
    expect(state.pages.get(0)).toEqual({ status: 'loading' });
  });

  it('drops pages beyond a shrunk total and reports placeholders past it', () => {
    let s = stateWithLoaded([0, 1, 2]);
    s = acceptPage(s, 'k', 0, items(0), 70);
    expect(s.pages.has(2)).toBe(false);
    expect(s.pages.has(1)).toBe(true);
    expect(slotAt(s, 69).kind).toBe('loaded');
    expect(slotAt(s, 70)).toEqual({ kind: 'placeholder' });
    expect(slotAt(s, 130)).toEqual({ kind: 'placeholder' });
  });

  it('drops pages beyond the total by the given page size', () => {
    const s = acceptPage(markLoading(emptyPaged<number>('k'), [1, 2, 3]), 'k', 0, [0, 1, 2], 25, 10);
    expect([...s.pages.keys()].sort()).toEqual([0, 1, 2]);
    expect(acceptPage(emptyPaged<number>('k'), 'k', 3, [30], 25, 10).pages.has(3)).toBe(false);
  });

  it('handles a total of 0', () => {
    const s = acceptPage(stateWithLoading([0]), 'k', 0, [], 0);
    expect(s.total).toBe(0);
    expect(s.pages.size).toBe(0);
    expect(slotAt(s, 0)).toEqual({ kind: 'placeholder' });
  });
});

describe('rejectPage / retryPage', () => {
  it('ignores stale keys and loaded pages', () => {
    const s = stateWithLoading([1]);
    expect(rejectPage(s, 'old', 1)).toBe(s);
    const loaded = stateWithLoaded([1]);
    expect(rejectPage(loaded, 'k', 1)).toBe(loaded);
  });

  it('records no failed entry for a page beyond the total', () => {
    const known = acceptPage(emptyPaged<number>('k'), 'k', 0, items(0), 70);
    const beyond = rejectPage(known, 'k', 2);
    expect(beyond.pages.has(2)).toBe(false);
    expect(slotAt(beyond, 125)).toEqual({ kind: 'placeholder' });
    const loadingBeyond = rejectPage(markLoading(known, [2]), 'k', 2);
    expect(loadingBeyond.pages.has(2)).toBe(false);
    expect(rejectPage(known, 'k', 3, 10).pages.has(3)).toBe(true);
    expect(rejectPage(known, 'k', 7, 10).pages.has(7)).toBe(false);
  });

  it('marks failed and retry clears only failed pages', () => {
    const s = rejectPage(stateWithLoading([1]), 'k', 1);
    expect(s.pages.get(1)).toEqual({ status: 'failed' });
    expect(retryPage(s, 1).pages.has(1)).toBe(false);
    const loaded = stateWithLoaded([0]);
    expect(retryPage(loaded, 0)).toBe(loaded);
  });
});

describe('slotAt', () => {
  it('maps indexes to slots', () => {
    const loaded = stateWithLoaded([0]);
    expect(slotAt(loaded, 59)).toEqual({ kind: 'loaded', item: 59 });
    expect(slotAt(loaded, 60)).toEqual({ kind: 'placeholder' });
    expect(slotAt(stateWithLoading([0]), 3)).toEqual({ kind: 'placeholder' });
    const s = rejectPage(stateWithLoaded([0]), 'k', 1);
    expect(slotAt(s, 61)).toEqual({ kind: 'failed', page: 1 });
  });

  it('a failed page keeps the failure text for its slots', () => {
    const s = rejectPage(stateWithLoading([1]), 'k', 1, PAGE_SIZE, 'The folder cannot be reached.');
    expect(s.pages.get(1)).toEqual({ status: 'failed', message: 'The folder cannot be reached.' });
    expect(slotAt(s, 61)).toEqual({ kind: 'failed', page: 1, message: 'The folder cannot be reached.' });
  });

  it('is placeholder for invalid indexes and short pages', () => {
    const loaded = stateWithLoaded([0]);
    expect(slotAt(loaded, -1)).toEqual({ kind: 'placeholder' });
    expect(slotAt(loaded, Number.NaN)).toEqual({ kind: 'placeholder' });
    const short = acceptPage(emptyPaged<number>('k'), 'k', 0, items(0, 5), 100);
    expect(slotAt(short, 7)).toEqual({ kind: 'placeholder' });
  });
});

describe('retryIndex', () => {
  it('is the first slot of the page when that slot is rendered', () => {
    expect(retryIndex(2, 100)).toBe(120);
    expect(retryIndex(0, 0)).toBe(0);
  });

  it('moves to the first visible slot when the page starts above the viewport', () => {
    expect(retryIndex(1, 75)).toBe(75);
  });
});

describe('patchItems', () => {
  const record = (id: string, v = 0) => ({ id, v });
  const base = () =>
    acceptPage(
      acceptPage(emptyPaged<{ id: string; v: number }>('k'), 'k', 0, [record('a'), record('b')], 200),
      'k',
      1,
      [record('c')],
      200,
    );

  it('replaces the loaded items with a matching id and keeps untouched pages identical', () => {
    const state = base();
    const next = patchItems(state, [record('b', 1)]);
    expect(next).not.toBe(state);
    expect(next.key).toBe('k');
    expect(next.total).toBe(200);
    expect(next.pages.get(0)).toEqual({ status: 'loaded', items: [record('a'), record('b', 1)] });
    expect(next.pages.get(1)).toBe(state.pages.get(1));
    // The input is not mutated.
    expect(state.pages.get(0)).toEqual({ status: 'loaded', items: [record('a'), record('b')] });
  });

  it('returns the state itself when no id matches', () => {
    const state = base();
    expect(patchItems(state, [record('x', 1)])).toBe(state);
    expect(patchItems(state, [])).toBe(state);
  });

  it('leaves loading and failed pages alone', () => {
    const state = rejectPage(markLoading(base(), [2]), 'k', 3);
    const next = patchItems(state, [record('c', 1)]);
    expect(next.pages.get(2)).toEqual({ status: 'loading' });
    expect(next.pages.get(3)).toEqual({ status: 'failed' });
    expect(next.pages.get(1)).toEqual({ status: 'loaded', items: [record('c', 1)] });
  });
});

describe('pagesToRequest with pages to fetch again', () => {
  it('requests a present page listed in `again` within the cap', () => {
    const loaded = stateWithLoaded([0, 1]);
    expect(pagesToRequest(loaded, [0, 1, 2], 2, 0, new Set([1]))).toEqual([1, 2]);
    expect(pagesToRequest(loaded, [0, 1], 2, 1, new Set([0, 1]))).toEqual([0]);
  });
});

describe('loadedIds', () => {
  it('answers each loaded id once, in the order asked, so a read of chosen ids never repeats one', () => {
    const state = acceptPage(emptyPaged<{ id: string }>('k'), 'k', 0, [{ id: 'a' }, { id: 'b' }], 200);
    expect(loadedIds(state, ['b', 'x', 'a', 'b', 'a'])).toEqual(['b', 'a']);
    expect(loadedIds(state, [])).toEqual([]);
  });
});
