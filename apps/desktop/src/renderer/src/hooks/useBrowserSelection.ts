import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { freshSelected, selectableFiles, type BrowserLatest } from '../components/file-browser-state';
import type { PagedState } from '../paged-list';
import { MAX_SELECTION, refreshSelected, selectAll } from '../selection';

// The upkeep of the file browser's selection: the shift anchor is dropped on a filter change, selected files show
// their latest records, and Ctrl+A selects once the pages up to MAX_SELECTION have settled.

/**
 * Keeps the host's selection in step with the displayed list.
 *
 * @param latest the values of the browser's latest render
 * @param filterKey the key of the filters and the scope, without the reload token
 * @param state the displayed list
 * @returns starts Ctrl+A: loads the pages up to MAX_SELECTION, then selects their files
 */
export function useBrowserSelection(
  latest: MutableRefObject<BrowserLatest>,
  filterKey: string,
  state: PagedState<FileRecord>,
): () => void {
  // A shift range is relative to the list it started in.
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    const { selection: current, onSelectionChange } = latest.current.props;
    if (current.anchor !== null) onSelectionChange({ ...current, anchor: null });
  }, [filterKey]);

  // Selected files show their latest records once a page holding them is loaded.
  useEffect(() => {
    const { selection: current, onSelectionChange } = latest.current.props;
    if (current.selected.size === 0) return;
    const fresh = freshSelected(current.selected, state);
    if (fresh.length > 0) onSelectionChange(refreshSelected(current, fresh));
  }, [state]);

  // Ctrl+A: after the pages up to MAX_SELECTION have settled, the next render selects them.
  const [selectAllRequest, setSelectAllRequest] = useState(0);
  useEffect(() => {
    if (selectAllRequest === 0) return;
    const { paged: current, props: currentProps } = latest.current;
    if (current.pending || current.state.total === null) return;
    currentProps.onSelectionChange(selectAll(selectableFiles(current.state, current.state.total)));
  }, [selectAllRequest]);

  return () => {
    latest.current.paged.loadThrough(MAX_SELECTION).then(
      () => setSelectAllRequest((count) => count + 1),
      // The list changed or unmounted first; nothing is selected.
      () => {},
    );
  };
}
