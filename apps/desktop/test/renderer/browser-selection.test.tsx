import { renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import type { BrowserLatest } from '../../src/renderer/src/components/file-browser-state';
import { useBrowserSelection } from '../../src/renderer/src/hooks/useBrowserSelection';
import type { PagedState } from '../../src/renderer/src/paged-list';
import type { FileSelection } from '../../src/renderer/src/selection';
import { fileRecord, tagOf } from './fixtures';

/** A list of one loaded page holding `items`. */
function stateOf(key: string, items: readonly FileRecord[]): PagedState<FileRecord> {
  return { key, total: items.length, pages: new Map([[0, { status: 'loaded', items }]]) };
}

/** The hook under a host that keeps the selection in its own state, as the screens do. */
function useHost(props: { filterKey: string; state: PagedState<FileRecord>; initial: FileSelection }) {
  const [selection, setSelection] = useState(props.initial);
  // Only the props the hook reads; the rest of the browser's latest values play no part here.
  const latest = useRef({} as BrowserLatest);
  latest.current = { props: { selection, onSelectionChange: setSelection } } as unknown as BrowserLatest;
  useBrowserSelection(latest, props.filterKey, props.state);
  return selection;
}

it('a filter change and fresh records in the same commit drop the anchor and refresh the records', () => {
  const file = fileRecord({ originalName: 'a.png' });
  const initial: FileSelection = { selected: new Map([[file.id, file]]), anchor: 0 };
  const { result, rerender } = renderHook((props) => useHost(props), {
    initialProps: { filterKey: 'one', state: stateOf('one', [file]), initial },
  });
  expect(result.current.anchor).toBe(0);

  const fresh = { ...file, tags: [tagOf('Moss')] };
  rerender({ filterKey: 'two', state: stateOf('two', [fresh]), initial });
  expect(result.current.anchor).toBeNull();
  expect(result.current.selected.get(file.id)).toBe(fresh);
});
