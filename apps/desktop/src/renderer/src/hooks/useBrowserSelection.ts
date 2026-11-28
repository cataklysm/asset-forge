import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { freshSelected, selectableFiles, type BrowserLatest } from '../components/file-browser-state';
import type { PagedState } from '../paged-list';
import { MAX_SELECTION, refreshSelected, selectAll, type FileSelection } from '../selection';

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
  // A shift range is relative to the list it started in. Both upkeep steps are functional updates, so two of them in
  // one commit build on each other instead of on the selection of the last render.
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    if (latest.current.props.selection.anchor === null) return;
    latest.current.props.onSelectionChange(withoutAnchor);
  }, [filterKey]);

  // Selected files show their latest records once a page holding them is loaded.
  useEffect(() => {
    const { selection: current, onSelectionChange } = latest.current.props;
    if (current.selected.size === 0 || freshSelected(current.selected, state).length === 0) return;
    onSelectionChange((selection) => withFreshRecords(selection, state));
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

/**
 * The selection without its shift anchor.
 *
 * @param selection the current selection
 * @returns the same one when it has no anchor
 */
function withoutAnchor(selection: FileSelection): FileSelection {
  return selection.anchor === null ? selection : { ...selection, anchor: null };
}

/**
 * The selection with the loaded records of its files.
 *
 * @param selection the current selection
 * @param state the displayed list
 * @returns the same one when no selected record changed
 */
function withFreshRecords(selection: FileSelection, state: PagedState<FileRecord>): FileSelection {
  const fresh = freshSelected(selection.selected, state);
  return fresh.length > 0 ? refreshSelected(selection, fresh) : selection;
}
