import type { FileRecord, FileScope, IpcRequest } from '@assetforge/contracts';
import type { PagedList } from '../hooks/usePagedList';
import type { ViewHandle, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { PAGE_SIZE, slotAt, type PagedState } from '../paged-list';
import { MAX_SELECTION } from '../selection';
import type { FileBrowserProps } from './FileBrowser';

// The pure rules of the file browser: which pages it wants, which file the viewer moves to, which list a new file
// belongs to and which records it hands on.

/** Where a view starts after a filter change: at the top, without focus. */
export const TOP: ViewRestore = { scrollOffset: 0, index: null, focus: false };

/** The `files:list` request of the displayed list without paging. */
export type FileListRequest = Omit<IpcRequest<'files:list'>, 'limit' | 'offset'>;

/** The values of the file browser's latest render, read by its callbacks and effects. */
export interface BrowserLatest {
  props: FileBrowserProps;
  /** The mounted view: the displayed list's key and the view kind. */
  viewKey: string;
  paged: PagedList<FileRecord>;
  /** The list key, which changes with the scope, the filters and the reload token. */
  key: string;
  listRequest: FileListRequest;
}

/** A viewed file and its last known index in the displayed list. */
export interface TrackedFile {
  id: string;
  index: number;
}

/** The index range whose pages the film strip keeps loaded; both ends inclusive. */
export interface WantRange {
  first: number;
  last: number;
}

/** The visible rows of the mounted view, tagged with the view they came from. */
export type KeyedRows = VisibleRows & { viewKey: string };

/** What the open viewer needs loaded. */
export interface ViewerNeeds {
  /** The file the viewer shows; null when it is closed. */
  viewedId: string | null;
  /** The target of the latest `show` whose page is not loaded yet. */
  pendingShow: { index: number } | null;
  /** The last known index of the viewed file. */
  knownIndex: number | null;
  wantRange: WantRange | null;
}

/**
 * The page that holds a list index.
 *
 * @param index the list index
 * @returns the page number
 */
export function pageOf(index: number): number {
  return Math.floor(index / PAGE_SIZE);
}

/**
 * Whether a file added to an asset or the inbox belongs to the list of a scope.
 *
 * @param scope the scope of the list
 * @param assetId the asset the file was added to; null for the inbox
 * @returns true when the list must show the file
 */
export function addsTo(scope: FileScope, assetId: string | null): boolean {
  switch (scope.kind) {
    case 'asset':
      return scope.assetId === assetId;
    case 'inbox':
      return assetId === null;
    case 'all':
      return true;
    case 'trash':
      return false;
  }
}

/**
 * The `data-index` of the item that holds the focus inside an element.
 *
 * @param root the element to look in; null finds nothing
 * @returns the index, or null when the focus is not on an item inside `root`
 */
export function focusedIndex(root: HTMLElement | null): number | null {
  const active = document.activeElement;
  if (root === null || !(active instanceof Element) || !root.contains(active)) return null;
  const value = active.closest('[data-index]')?.getAttribute('data-index');
  const index = value === undefined || value === null ? NaN : Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Where the view starts again after a reload: at its scroll offset, with the focused item focused again.
 *
 * @param position the handle of the mounted view
 * @param viewKey the current view; a handle of another view counts as no position
 * @param container the browser's element, where the focus is looked for
 * @returns the restore of the remounted view
 */
export function reloadRestore(
  position: ViewHandle | null,
  viewKey: string,
  container: HTMLElement | null,
): ViewRestore {
  const current = position?.viewKey === viewKey ? position.get() : null;
  const focused = focusedIndex(container);
  return { scrollOffset: current?.scrollOffset ?? 0, index: focused, focus: focused !== null };
}

/**
 * The pages the open viewer needs: a pending `show` target, the viewed file and its neighbours, the `want` range.
 *
 * @param count the number of files in the list
 * @param needs the viewed file, the pending target and the wanted range
 * @returns the page numbers, possibly repeated; none while the viewer is closed or the list is empty
 */
export function viewerPages(count: number, needs: ViewerNeeds): number[] {
  const { viewedId, pendingShow, knownIndex, wantRange } = needs;
  if (viewedId === null || count === 0) return [];
  const pages: number[] = [];
  const add = (index: number) => {
    if (index >= 0 && index < count) pages.push(pageOf(index));
  };
  if (pendingShow !== null) add(Math.min(pendingShow.index, count - 1));
  if (knownIndex !== null) {
    for (const index of [knownIndex, knownIndex - 1, knownIndex + 1]) add(index);
    add(Math.min(knownIndex, count - 1));
  }
  if (wantRange !== null) {
    const first = Math.max(0, wantRange.first);
    const last = Math.min(count - 1, wantRange.last);
    for (let page = pageOf(first); first <= last && page <= pageOf(last); page += 1) pages.push(page);
  }
  return pages;
}

/**
 * The file that replaces a viewed file that left the displayed list: the one now at its last index (the one that
 * followed it), else the last file, else none.
 *
 * @param state the displayed list
 * @param last the viewed file and its last known index
 * @returns `{ file }` with the replacement (null closes the viewer), or null while a page it depends on has not
 *   settled
 */
export function replacementOf(state: PagedState<FileRecord>, last: TrackedFile): { file: FileRecord | null } | null {
  const count = state.total;
  if (count === null) return null;
  if (count === 0) return { file: null };
  // The file may have moved to a neighbouring page; decide once those have settled.
  for (const index of [last.index - 1, last.index, last.index + 1]) {
    if (index < 0 || index >= count) continue;
    const status = state.pages.get(pageOf(index))?.status;
    if (status !== 'loaded' && status !== 'failed') return null;
  }
  const slot = slotAt(state, Math.min(last.index, count - 1));
  return slot.kind === 'loaded' ? { file: slot.item } : null;
}

/**
 * The loaded records of selected files that differ from the selected ones.
 *
 * @param selected the selected files by id
 * @param state the displayed list
 * @returns the fresh records, in page order
 */
export function freshSelected(selected: ReadonlyMap<string, FileRecord>, state: PagedState<FileRecord>): FileRecord[] {
  const fresh: FileRecord[] = [];
  for (const entry of state.pages.values()) {
    if (entry.status !== 'loaded') continue;
    for (const file of entry.items) {
      const previous = selected.get(file.id);
      if (previous !== undefined && previous !== file) fresh.push(file);
    }
  }
  return fresh;
}

/**
 * The loaded files among the first `MAX_SELECTION` of a list, for Ctrl+A.
 *
 * @param state the displayed list; its total must be known
 * @param total the number of files in the list
 * @returns the loaded files in list order
 */
export function selectableFiles(state: PagedState<FileRecord>, total: number): FileRecord[] {
  const end = Math.min(total, MAX_SELECTION);
  const files: FileRecord[] = [];
  for (let index = 0; index < end; index += 1) {
    const slot = slotAt(state, index);
    if (slot.kind === 'loaded') files.push(slot.item);
  }
  return files;
}

/**
 * The rows to keep: the previous ones when nothing changed, so the state stays the same object.
 *
 * @param previous the rows kept so far
 * @param visible the rows the view reports
 * @param viewKey the view they come from
 * @returns `previous` when it matches, otherwise the new rows
 */
export function nextRows(previous: KeyedRows | null, visible: VisibleRows, viewKey: string): KeyedRows {
  return previous !== null &&
    previous.viewKey === viewKey &&
    previous.firstRow === visible.firstRow &&
    previous.lastRow === visible.lastRow &&
    previous.columns === visible.columns
    ? previous
    : { ...visible, viewKey };
}
