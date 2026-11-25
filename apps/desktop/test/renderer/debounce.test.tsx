import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../../src/renderer/src/hooks/useDebouncedValue';

afterEach(() => {
  vi.useRealTimers();
});

function probe() {
  const seen: string[] = [];
  function Probe({ q }: { q: string }) {
    const d = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
    seen.push(d);
    return null;
  }
  return { seen, Probe };
}

it('only the last query of a burst is requested after 250 ms', () => {
  vi.useFakeTimers();
  expect(SEARCH_DEBOUNCE_MS).toBe(250);
  const { seen, Probe } = probe();
  const { rerender } = render(<Probe q="" />);
  rerender(<Probe q="o" />);
  rerender(<Probe q="oa" />);
  rerender(<Probe q="oak" />);
  act(() => vi.advanceTimersByTime(249));
  expect(seen.at(-1)).toBe('');
  act(() => vi.advanceTimersByTime(1));
  expect(seen.at(-1)).toBe('oak');
  expect(seen).not.toContain('o');
  expect(seen).not.toContain('oa');
});

it('clearing to the empty string is not delayed', () => {
  vi.useFakeTimers();
  const { seen, Probe } = probe();
  const { rerender } = render(<Probe q="oak" />);
  expect(seen.at(-1)).toBe('oak');
  rerender(<Probe q="oa" />);
  rerender(<Probe q="" />);
  expect(seen.at(-1)).toBe('');
  act(() => vi.advanceTimersByTime(1000));
  expect(seen.at(-1)).toBe('');
  expect(seen).not.toContain('oa');
});
