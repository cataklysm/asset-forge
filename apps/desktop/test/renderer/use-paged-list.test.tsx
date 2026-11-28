import { act, render, renderHook, waitFor } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { usePagedList } from '../../src/renderer/src/hooks/usePagedList';
import { slotAt } from '../../src/renderer/src/paged-list';

interface Item {
  id: string;
}

/** A page of `total` items starting at `offset`. */
function pageOf(offset: number, limit: number, total: number): { items: Item[]; total: number } {
  const end = Math.min(offset + limit, total);
  return { items: Array.from({ length: Math.max(0, end - offset) }, (_, i) => ({ id: `item-${offset + i}` })), total };
}

const PAGE_ZERO = [0] as const;

it('retry requests a failed page again and shows its answer', async () => {
  let fail = true;
  const fetchPage = vi.fn(async (offset: number, limit: number) => {
    if (fail) throw new Error('boom');
    return pageOf(offset, limit, 3);
  });
  const { result } = renderHook(() => usePagedList<Item>('A', fetchPage, PAGE_ZERO));
  await waitFor(() => expect(slotAt(result.current.state, 0)).toEqual({ kind: 'failed', page: 0, message: 'boom' }));
  fail = false;
  act(() => result.current.retry(0));
  await waitFor(() => expect(result.current.state.total).toBe(3));
  expect(slotAt(result.current.state, 2)).toEqual({ kind: 'loaded', item: { id: 'item-2' } });
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

it('a new key is pending in the render that brings it, and the old list stays shown', async () => {
  const fetchPage = vi.fn(async (offset: number, limit: number) => pageOf(offset, limit, 2));
  const { result, rerender } = renderHook(({ key }) => usePagedList<Item>(key, fetchPage, PAGE_ZERO), {
    initialProps: { key: 'A' },
  });
  await waitFor(() => expect(result.current.state.total).toBe(2));
  const before = result.current.state;
  rerender({ key: 'B' });
  expect(result.current.pending).toBe(true);
  expect(result.current.state).toBe(before);
  await waitFor(() => expect(result.current.pending).toBe(false));
});

/** Shows nothing once a child threw while rendering. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** A list that throws in the render with `throws`, after the hook has run. */
function ThrowingList({ listKey, throws, fetchPage }: { listKey: string; throws: boolean; fetchPage: Fetch }) {
  usePagedList<Item>(listKey, fetchPage, PAGE_ZERO);
  if (throws) throw new Error('render failed');
  return null;
}

type Fetch = (offset: number, limit: number) => Promise<{ items: Item[]; total: number }>;

it('a render that is thrown away requests nothing for its key', async () => {
  const keys: string[] = [];
  const fetchFor = (key: string): Fetch => {
    return async (offset, limit) => {
      keys.push(key);
      return pageOf(offset, limit, 1);
    };
  };
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { rerender } = render(
      <Boundary>
        <ThrowingList listKey="A" throws={false} fetchPage={fetchFor('A')} />
      </Boundary>,
    );
    await waitFor(() => expect(keys).toEqual(['A']));
    rerender(
      <Boundary>
        <ThrowingList listKey="B" throws fetchPage={fetchFor('B')} />
      </Boundary>,
    );
    await act(async () => {});
    expect(keys).toEqual(['A']);
  } finally {
    spy.mockRestore();
  }
});
