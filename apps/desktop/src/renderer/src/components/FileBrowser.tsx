import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { FileListFilter, FileRecord, FileScope } from '@assetforge/contracts';
import { call } from '../api';
import { pagesForRows } from '../gallery';
import { useBrowserSelection } from '../hooks/useBrowserSelection';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useFileListChanges } from '../hooks/useFileListChanges';
import { useViewerSync, useViewerTracking } from '../hooks/useFileViewer';
import { usePagedList, type PagedList } from '../hooks/usePagedList';
import type { ViewHandle, ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { hasFilters, listKey, NO_FILE_FILTERS, toFileQuery, type AssetView, type FileFilters } from '../list-state';
import { PAGE_SIZE, slotAt, type Slot } from '../paged-list';
import { clickSelect, NO_SELECTION, toggleSelect, type FileSelection, type ItemAt } from '../selection';
import { BUTTON, MUTED } from '../ui';
import {
  nextRows,
  reloadRestore,
  TOP,
  viewerPages,
  type BrowserLatest,
  type KeyedRows,
} from './file-browser-state';
import { FileBrowserToolbar } from './FileBrowserToolbar';
import { FileGridView, TILE_HEIGHT, TILE_WIDTH } from './FileGridView';
import { FileTable } from './FileTable';
import type { FileViewProps } from './FileTile';
import type { MenuItem } from './Menu';

const SKELETON_TILES = 6;

/** What the host of a file browser gives it. */
export interface FileBrowserProps {
  scope: FileScope;
  filters: FileFilters;
  onFiltersChange(filters: FileFilters): void;
  /** The Role filter: asset files yes, inbox no. */
  showRoleFilter: boolean;
  view: AssetView;
  onViewChange(view: AssetView): void;
  /** Where the first mounted view starts; read once on mount. */
  restore?: ViewRestore;
  /** Receives the current position (on row changes, before opening a file and on unmount). */
  positionRef?: MutableRefObject<ViewPosition | null>;
  selection: FileSelection;
  onSelectionChange(selection: FileSelection): void;
  /**
   * Part of the list key; bump after a mutation to refetch. The position is kept. Background changes
   * (jobs) never go through it: the list follows the change feed in place.
   */
  reloadToken: number;
  /** Shows the "Cover" badge on this file. */
  coverFileId?: string | null;
  /** Enter, double click, the magnifier and the host's "Details" menu item. */
  onOpen(file: FileRecord): void;
  /** The tile "…" menu; no menu without items. */
  menuItems(file: FileRecord): MenuItem[];
  /** The Delete key on a focused file (never from an input or an inner control). */
  onDeleteKey?(): void;
  /** Shown when the unfiltered list is empty ("No files" / "Inbox is empty"). */
  emptyText: string;
  /** Shown below `emptyText` (e.g. the inbox's "Import files"). */
  emptyAction?: ReactNode;
  onTotal?(total: number | null): void;
  /**
   * The proposal filter and "Analyse all" in the toolbar. `onAnalyseAll` receives the filter the
   * list shows; `blocked` disables it with that tooltip (e.g. the provider is not configured).
   */
  analysis?: {
    onAnalyseAll(filter: FileListFilter): void;
    blocked: string | null;
  };
  /** The host's file detail dialog, which browses this list. */
  viewer?: {
    /** The file the host's dialog shows; null when closed. */
    fileId: string | null;
    /** The dialog must show this file now; null closes it. */
    onView(file: FileRecord | null): void;
    render(list: ViewerList): ReactNode;
  };
}

/** The displayed list as the viewer sees it. */
export interface ViewerList {
  total: number;
  /** Position of the viewed file in the list. */
  index: number;
  slot(index: number): Slot<FileRecord>;
  /** Shows the file at `index`: loads its page when needed, then calls `onView(file)`. Clamped to 0 … total − 1; the latest call wins. */
  show(index: number): void;
  /** Keeps the pages of this index range loaded (film strip). */
  want(first: number, last: number): void;
}

/**
 * A paginated, virtualised list of files as tiles or a table, with its filters, endless
 * scrolling and multi-select (see `selection.ts`). Mounted by the asset Files tab, the inbox and
 * the trash, which shows the deletion date and the origin and never the role filter.
 *
 * @param props the scope, the filters, the selection and the host's handlers
 * @returns the filter bar, the list and the host's viewer
 */
export function FileBrowser(props: FileBrowserProps) {
  const { scope, filters, onFiltersChange, view, onViewChange, selection, reloadToken } = props;
  const showRole = scope.kind === 'asset';
  const showOrigin = scope.kind === 'trash';
  // The trash has no roles.
  const showRoleFilter = props.showRoleFilter && !showOrigin;

  // Only the text is debounced, trimmed before it enters the key; the role is ignored while hidden.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: FileFilters = { ...filters, query, role: showRoleFilter ? filters.role : '' };
  // Only files with a tag proposal; a list filter, never part of an analysis target.
  const [proposals, setProposals] = useState(false);
  const withProposals = props.analysis !== undefined && proposals;
  const scopeText = JSON.stringify([scope, withProposals]);
  const filterKey = listKey(effective, scopeText);
  const key = listKey(effective, JSON.stringify([scope, withProposals, reloadToken]));
  const filtered = hasFilters(effective) || withProposals;

  const containerRef = useRef<HTMLDivElement>(null);
  const restore = useRef<ViewRestore>(props.restore ?? TOP);
  const position = useRef<ViewHandle | null>(null);
  const [rows, setRows] = useState<KeyedRows | null>(null);

  // The list's request without paging; also the base of a read of chosen ids.
  const listRequest = { ...toFileQuery(scope, effective), ...(withProposals ? { hasProposal: true } : {}) };
  const fetchPage = useCallback(
    (offset: number, limit: number) => call('files:list', { limit, offset, ...listRequest }),
    // `key` encodes the scope and every filter value used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const bootPage = Math.floor((restore.current.index ?? 0) / PAGE_SIZE);
  const [wanted, setWanted] = useState<readonly number[]>([bootPage]);
  const paged = usePagedList<FileRecord>(key, fetchPage, wanted);
  const total = paged.state.total;
  // Keyed by the displayed list: while a new key loads, the old view stays mounted where it was.
  const viewKey = `${paged.state.key}|${view}`;

  // A reload keeps the position and the focused item: the view remounts with the new list.
  const lastToken = useRef(reloadToken);
  if (lastToken.current !== reloadToken) {
    lastToken.current = reloadToken;
    restore.current = reloadRestore(position.current, viewKey, containerRef.current);
  }

  const viewedId = props.viewer?.fileId ?? null;
  const tracking = useViewerTracking(paged.state, viewedId);
  const rowPages =
    total !== null && rows !== null && rows.viewKey === viewKey
      ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
      : [];
  const nextWanted =
    total === null ? [bootPage] : [...new Set([...viewerPages(total, { viewedId, ...tracking }), ...rowPages])];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  const latest = useRef<BrowserLatest>({ props, viewKey, paged, key, listRequest });
  latest.current = { props, viewKey, paged, key, listRequest };

  useFileListChanges(scope, latest);
  const viewerList = useViewerSync({ tracking, latest, position, viewedId, state: paged.state, pending: paged.pending });

  useEffect(() => () => publishPosition(latest, position), []);

  useEffect(() => {
    latest.current.props.onTotal?.(total);
  }, [total]);

  const selectAllLater = useBrowserSelection(latest, filterKey, paged.state);

  const itemAt: ItemAt = (index) => {
    const slot = slotAt(paged.state, index);
    return slot.kind === 'loaded' ? slot.item : null;
  };

  function setFilter(change: Partial<FileFilters>) {
    restore.current = TOP;
    onFiltersChange({ ...filters, ...change });
  }

  function switchView(next: AssetView) {
    if (next === view) return;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    restore.current = { scrollOffset: 0, index: current?.firstIndex ?? null, focus: false };
    onViewChange(next);
  }

  const onRows = useCallback(
    (visible: VisibleRows) => {
      setRows((previous) => nextRows(previous, visible, viewKey));
      publishPosition(latest, position);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewKey],
  );

  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;
  const viewProps =
    total === null || total === 0
      ? null
      : fileViewProps({
          props,
          paged,
          total,
          viewKey,
          restore: restore.current,
          showRole,
          showOrigin,
          itemAt,
          onRows,
          onSelectAll: selectAllLater,
          onOpen: (file) => {
            publishPosition(latest, position);
            props.onOpen(file);
          },
          position,
        });

  return (
    <>
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3">
        <FileBrowserToolbar
          total={total}
          filters={filters}
          showRoleFilter={showRoleFilter}
          view={view}
          canClear={hasFilters(showRoleFilter ? filters : { ...filters, role: '' }) || withProposals}
          onClear={() => {
            setProposals(false);
            setFilter(NO_FILE_FILTERS);
          }}
          onFilter={setFilter}
          onSwitchView={switchView}
          analysis={
            props.analysis === undefined
              ? undefined
              : {
                  proposals: withProposals,
                  onToggleProposals: () => {
                    restore.current = TOP;
                    setProposals((on) => !on);
                  },
                  blocked: props.analysis.blocked,
                  onAnalyseAll: () => props.analysis?.onAnalyseAll(toFileQuery(scope, effective)),
                }
          }
        />
        <FileListBody
          pending={paged.pending}
          failedPage={failedPage}
          total={total}
          viewProps={viewProps}
          filtered={filtered}
          emptyText={props.emptyText}
          emptyAction={props.emptyAction}
          view={view}
          onRetry={paged.retry}
        />
      </div>
      {/* Modal, so its place does not matter; outside the list, focus in it never counts as focus in the list. */}
      {viewerList !== null && props.viewer?.render(viewerList)}
    </>
  );
}

/**
 * Hands the position of the mounted view to the host, when the handle belongs to the current view.
 *
 * @param latest the values of the latest render
 * @param position the handle of the mounted view
 */
function publishPosition(latest: MutableRefObject<BrowserLatest>, position: MutableRefObject<ViewHandle | null>): void {
  const { props: current, viewKey } = latest.current;
  if (current.positionRef && position.current?.viewKey === viewKey) current.positionRef.current = position.current.get();
}

/** What `fileViewProps` builds the view's props from. */
interface ViewPropsSource {
  props: FileBrowserProps;
  paged: PagedList<FileRecord>;
  total: number;
  viewKey: string;
  restore: ViewRestore;
  showRole: boolean;
  showOrigin: boolean;
  itemAt: ItemAt;
  onRows(visible: VisibleRows): void;
  onSelectAll(): void;
  onOpen(file: FileRecord): void;
  position: MutableRefObject<ViewHandle | null>;
}

/**
 * The props of the grid or the table view.
 *
 * @param source the browser's props, the displayed list and the handlers
 * @returns the view's props
 */
function fileViewProps(source: ViewPropsSource): FileViewProps {
  const { props, paged, itemAt } = source;
  const { selection } = props;
  return {
    viewKey: source.viewKey,
    paged: paged.state,
    total: source.total,
    restore: source.restore,
    showRole: source.showRole,
    showOrigin: source.showOrigin,
    coverFileId: props.coverFileId ?? null,
    selected: selection.selected,
    onClickItem: (index, modifiers) => props.onSelectionChange(clickSelect(selection, index, itemAt, modifiers)),
    onToggle: (index) => props.onSelectionChange(toggleSelect(selection, index, itemAt)),
    onSelectAll: source.onSelectAll,
    onClear: () => {
      if (selection.selected.size === 0 && selection.anchor === null) return false;
      props.onSelectionChange(NO_SELECTION);
      return true;
    },
    onOpen: source.onOpen,
    menuItems: props.menuItems,
    onRows: source.onRows,
    onRetry: paged.retry,
    positionRef: source.position,
    onDeleteKey: props.onDeleteKey,
  };
}

/** What the list part of the browser shows. */
interface FileListBodyProps {
  pending: boolean;
  /** A failed page while the total is unknown; null when none failed. */
  failedPage: number | null;
  total: number | null;
  /** The view's props; null while the list is unknown or empty. */
  viewProps: FileViewProps | null;
  filtered: boolean;
  emptyText: string;
  emptyAction?: ReactNode;
  view: AssetView;
  onRetry(page: number): void;
}

/**
 * The list part of the browser: Retry, the skeleton, the empty text or the grid or table view.
 *
 * @param props the state of the list
 * @returns the list part
 */
function FileListBody(props: FileListBodyProps) {
  const { failedPage, total, viewProps, filtered, emptyText } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={props.pending || undefined}>
      {failedPage !== null ? (
        <div>
          <button type="button" className={BUTTON} onClick={() => props.onRetry(failedPage)}>
            Retry
          </button>
        </div>
      ) : total === null ? (
        <div className="flex flex-wrap gap-4" aria-busy="true">
          {Array.from({ length: SKELETON_TILES }, (_, i) => (
            <div
              key={i}
              data-skeleton=""
              className="animate-pulse rounded-tile bg-raised"
              style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
            />
          ))}
        </div>
      ) : viewProps === null ? (
        filtered || props.emptyAction === undefined ? (
          <p className={MUTED}>{filtered ? 'No matching files' : emptyText}</p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className={MUTED}>{emptyText}</p>
            {props.emptyAction}
          </div>
        )
      ) : props.view === 'grid' ? (
        <FileGridView key={viewProps.viewKey} {...viewProps} />
      ) : (
        <FileTable key={viewProps.viewKey} {...viewProps} />
      )}
    </div>
  );
}
