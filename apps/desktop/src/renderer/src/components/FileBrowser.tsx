import { LayoutGrid, List, Sparkles, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  FileRoleSchema,
  MAX_CHOSEN_IDS,
  type FileListFilter,
  type FileRecord,
  type FileScope,
} from '@assetforge/contracts';
import { call } from '../api';
import { useChanges } from '../jobs-context';
import { pagesForRows } from '../gallery';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewHandle, ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { FILE_KIND_OPTIONS, label, PROPOSALS_BLOCK_ANALYSE_ALL, PROPOSALS_LABEL, PROPOSALS_TITLE } from '../labels';
import { hasFilters, listKey, NO_FILE_FILTERS, toFileQuery, type AssetView, type FileFilters } from '../list-state';
import { findLoaded, loadedIds, PAGE_SIZE, slotAt, type Slot } from '../paged-list';
import {
  clickSelect,
  MAX_SELECTION,
  NO_SELECTION,
  refreshSelected,
  selectAll,
  toggleSelect,
  type FileSelection,
  type ItemAt,
} from '../selection';
import { BUTTON, ICON_BUTTON, MUTED, SELECT } from '../ui';
import { AnalyseAllButton } from './AnalysisDialogs';
import { FileGridView, TILE_HEIGHT, TILE_WIDTH } from './FileGridView';
import { FileTable } from './FileTable';
import type { FileViewProps } from './FileTile';
import { FilterBar } from './FilterBar';
import type { MenuItem } from './Menu';
import { SearchField } from './SearchField';
import { TagFilter } from './TagFilter';

const ROLES = FileRoleSchema.options;
const KINDS = FILE_KIND_OPTIONS;

const VIEWS = [
  { view: 'grid', tooltip: 'Show as tiles', icon: LayoutGrid },
  { view: 'table', tooltip: 'Show as table', icon: List },
] satisfies { view: AssetView; tooltip: string; icon: LucideIcon }[];

const TOP: ViewRestore = { scrollOffset: 0, index: null, focus: false };
const SKELETON_TILES = 6;

export interface FileBrowserProps {
  scope: FileScope;
  filters: FileFilters;
  onFiltersChange(f: FileFilters): void;
  /** The Role filter: asset files yes, inbox no. */
  showRoleFilter: boolean;
  view: AssetView;
  onViewChange(v: AssetView): void;
  /** Where the first mounted view starts; read once on mount. */
  restore?: ViewRestore;
  /** Receives the current position (on row changes, before opening a file and on unmount). */
  positionRef?: MutableRefObject<ViewPosition | null>;
  selection: FileSelection;
  onSelectionChange(s: FileSelection): void;
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

const pageOf = (index: number) => Math.floor(index / PAGE_SIZE);

/** Whether a file added to `assetId` (null: the inbox) belongs to the list of `scope`. */
function addsTo(scope: FileScope, assetId: string | null): boolean {
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
 * A paginated, virtualised list of files as tiles or a table, with its filters, endless
 * scrolling and multi-select (see `selection.ts`). Mounted by the asset Files tab, the inbox and
 * the trash, which shows the deletion date and the origin and never the role filter.
 */
export function FileBrowser(props: FileBrowserProps) {
  const { scope, filters, onFiltersChange, view, onViewChange, selection, reloadToken, emptyText } = props;
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
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

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
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    const focused = focusedIndex(containerRef.current);
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: focused, focus: focused !== null };
  }

  // The viewer is tracked by file id; `tracked` keeps its last known index while a reload has not
  // yet loaded the page that holds it (and for the focus return after it closed).
  const viewer = props.viewer;
  const viewedId = viewer?.fileId ?? null;
  const tracked = useRef<{ id: string; index: number } | null>(null);
  const found = findLoaded(paged.state, viewedId);
  if (found !== null) tracked.current = { id: found.item.id, index: found.index };
  const knownIndex = viewedId !== null && tracked.current?.id === viewedId ? tracked.current.index : null;
  // The target of the latest `show` whose page is not loaded yet.
  const [pendingShow, setPendingShow] = useState<{ index: number } | null>(null);
  const [wantRange, setWantRange] = useState<{ first: number; last: number } | null>(null);
  // What the browser last asked the host to show, and from which file; never asked twice.
  const asked = useRef<{ from: string | null; to: string | null } | null>(null);

  /** The pages the open viewer needs: a pending `show` target, its neighbours, the `want` range. */
  function viewerPages(count: number): number[] {
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

  const rowPages =
    total !== null && rows !== null && rows.viewKey === viewKey
      ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
      : [];
  const nextWanted = total === null ? [bootPage] : [...new Set([...viewerPages(total), ...rowPages])];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  const latest = useRef({ props, viewKey, paged, key, listRequest });
  latest.current = { props, viewKey, paged, key, listRequest };

  // Background changes reach the list in place: changed records are read again and patched, a file
  // added to this list's place (or a reset) refreshes the loaded pages. The trash never reacts.
  useChanges((changes) => {
    if (scope.kind === 'trash') return;
    const { paged: current, key: startedKey, listRequest: request } = latest.current;
    if (changes.reset || changes.added.some((place) => addsTo(scope, place.assetId))) {
      current.refresh();
      return;
    }
    const ids = loadedIds(current.state, changes.fileIds);
    if (ids.length === 0) return;
    if (ids.length > MAX_CHOSEN_IDS) {
      current.refresh();
      return;
    }
    // No check beyond the key: a workspace read runs synchronously when the main process receives it, and IPC
    // answers arrive in the order asked, so a page requested after this read never answers before it.
    call('files:list', { ...request, ids, offset: 0, limit: ids.length }).then(
      (page) => {
        // Started for another list: its records must not reach this one. The current list may have been read
        // before the change, so it is read again (queued while its first page is still loading).
        if (latest.current.key !== startedKey) {
          refreshLatest();
          return;
        }
        if (page.items.length > 0) latest.current.paged.patch(page.items);
      },
      // The change must not be lost: the loaded pages are read again instead.
      () => refreshLatest(),
    );
  });

  /** Reads the loaded pages of the current list again; the trash never follows the feed. */
  function refreshLatest() {
    if (latest.current.props.scope.kind !== 'trash') latest.current.paged.refresh();
  }

  function ask(file: FileRecord | null) {
    const current = latest.current.props.viewer;
    if (current === undefined) return;
    asked.current = { from: current.fileId, to: file?.id ?? null };
    current.onView(file);
  }

  function show(index: number) {
    const { state } = latest.current.paged;
    const count = state.total;
    if (count === null) return;
    if (count === 0) {
      setPendingShow(null);
      ask(null);
      return;
    }
    const target = Math.min(Math.max(0, Math.trunc(index)), count - 1);
    const slot = slotAt(state, target);
    if (slot.kind !== 'loaded') {
      setPendingShow({ index: target });
      return;
    }
    setPendingShow(null);
    if (slot.item.id !== latest.current.props.viewer?.fileId) ask(slot.item);
  }

  // A pending `show` resolves once its page is loaded (clamped to a shrunk list). Without one, a
  // viewed file that left the displayed list is replaced by the file now at its last index (the
  // one that followed it), else the last file, else the viewer closes.
  useEffect(() => {
    if (viewedId === null) return;
    const { state } = paged;
    const count = state.total;
    if (count === null) return;
    if (pendingShow !== null) {
      if (count === 0) {
        setPendingShow(null);
        ask(null);
        return;
      }
      const slot = slotAt(state, Math.min(pendingShow.index, count - 1));
      if (slot.kind !== 'loaded') return;
      setPendingShow(null);
      if (slot.item.id !== viewedId) ask(slot.item);
      return;
    }
    if (paged.pending || findLoaded(state, viewedId) !== null) return;
    const last = tracked.current;
    if (last === null || last.id !== viewedId) return;
    let next: FileRecord | null = null;
    if (count > 0) {
      // The file may have moved to a neighbouring page; decide once those have settled.
      for (const index of [last.index - 1, last.index, last.index + 1]) {
        if (index < 0 || index >= count) continue;
        const status = state.pages.get(pageOf(index))?.status;
        if (status !== 'loaded' && status !== 'failed') return;
      }
      const slot = slotAt(state, Math.min(last.index, count - 1));
      if (slot.kind !== 'loaded') return;
      next = slot.item;
    }
    if (asked.current?.from === viewedId && asked.current.to === (next?.id ?? null)) return;
    ask(next);
    // `ask` reads the latest props itself.
  }, [paged.state, paged.pending, viewedId, pendingShow]);

  // A reload that brings a new record of the viewed file hands it to the viewer once, so the open
  // dialog shows the fresh data (e.g. tags added by an analysis job).
  const handed = useRef<FileRecord | null>(null);
  useEffect(() => {
    if (viewedId === null) {
      handed.current = null;
      return;
    }
    const record = findLoaded(paged.state, viewedId)?.item ?? null;
    if (record === null) return;
    const previous = handed.current;
    handed.current = record;
    if (previous !== null && previous.id === record.id && previous !== record) latest.current.props.viewer?.onView(record);
  }, [paged.state, viewedId]);

  // After the viewer closed, the tile of the file shown last comes into view and takes the focus.
  const lastViewed = useRef<string | null>(viewedId);
  useEffect(() => {
    const previous = lastViewed.current;
    lastViewed.current = viewedId;
    if (previous === null || viewedId !== null) return;
    setPendingShow(null);
    setWantRange(null);
    asked.current = null;
    const last = tracked.current;
    tracked.current = null;
    const { paged: current, viewKey: key } = latest.current;
    const count = current.state.total;
    if (last === null || last.id !== previous || count === null || count === 0) return;
    const index = findLoaded(current.state, previous)?.index ?? Math.min(last.index, count - 1);
    if (position.current?.viewKey === key) position.current.reveal(index);
  }, [viewedId]);

  const viewIndex =
    total === null || total === 0 ? null : (found?.index ?? (knownIndex === null ? null : Math.min(knownIndex, total - 1)));
  const viewerList: ViewerList | null =
    viewer !== undefined && viewedId !== null && total !== null && viewIndex !== null
      ? {
          total,
          index: viewIndex,
          slot: (index) => slotAt(paged.state, index),
          show,
          want: (first, last) =>
            setWantRange((old) => (old !== null && old.first === first && old.last === last ? old : { first, last })),
        }
      : null;

  function publishPosition() {
    const { props: current, viewKey: key } = latest.current;
    if (current.positionRef && position.current?.viewKey === key) current.positionRef.current = position.current.get();
  }

  useEffect(() => () => publishPosition(), []);

  useEffect(() => {
    latest.current.props.onTotal?.(total);
  }, [total]);

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
    const fresh: FileRecord[] = [];
    for (const entry of paged.state.pages.values()) {
      if (entry.status !== 'loaded') continue;
      for (const file of entry.items) {
        const old = current.selected.get(file.id);
        if (old !== undefined && old !== file) fresh.push(file);
      }
    }
    if (fresh.length > 0) onSelectionChange(refreshSelected(current, fresh));
  }, [paged.state]);

  // Ctrl+A: after the pages up to MAX_SELECTION have settled, the next render selects them.
  const [selectAllRequest, setSelectAllRequest] = useState(0);
  useEffect(() => {
    if (selectAllRequest === 0) return;
    const { paged: current, props: currentProps } = latest.current;
    if (current.pending || current.state.total === null) return;
    const end = Math.min(current.state.total, MAX_SELECTION);
    const files: FileRecord[] = [];
    for (let index = 0; index < end; index += 1) {
      const slot = slotAt(current.state, index);
      if (slot.kind === 'loaded') files.push(slot.item);
    }
    currentProps.onSelectionChange(selectAll(files));
  }, [selectAllRequest]);

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
      setRows((old) =>
        old !== null &&
        old.viewKey === viewKey &&
        old.firstRow === visible.firstRow &&
        old.lastRow === visible.lastRow &&
        old.columns === visible.columns
          ? old
          : { ...visible, viewKey },
      );
      publishPosition();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewKey],
  );

  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;
  const viewProps: FileViewProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore: restore.current,
          showRole,
          showOrigin,
          coverFileId: props.coverFileId ?? null,
          selected: selection.selected,
          onClickItem: (index, mods) => props.onSelectionChange(clickSelect(selection, index, itemAt, mods)),
          onToggle: (index) => props.onSelectionChange(toggleSelect(selection, index, itemAt)),
          onSelectAll: () => {
            paged.loadThrough(MAX_SELECTION).then(
              () => setSelectAllRequest((n) => n + 1),
              // The list changed or unmounted first; nothing is selected.
              () => {},
            );
          },
          onClear: () => {
            if (selection.selected.size === 0 && selection.anchor === null) return false;
            props.onSelectionChange(NO_SELECTION);
            return true;
          },
          onOpen: (file) => {
            publishPosition();
            props.onOpen(file);
          },
          menuItems: props.menuItems,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
          onDeleteKey: props.onDeleteKey,
        };

  return (
    <>
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3">
        <FilterBar
          resultCount={total === null ? null : `${total} ${total === 1 ? 'file' : 'files'}`}
          countTitle={total !== null && total > MAX_SELECTION ? `At most ${MAX_SELECTION} files can be selected` : undefined}
          onClear={
            hasFilters(showRoleFilter ? filters : { ...filters, role: '' }) || withProposals
              ? () => {
                  setProposals(false);
                  setFilter(NO_FILE_FILTERS);
                }
              : null
          }
        >
          <>
            <SearchField
              label="Search files"
              placeholder="Search files"
              value={filters.query}
              onChange={(text) => setFilter({ query: text })}
            />
            {showRoleFilter && (
              <select
                className={SELECT}
                aria-label="Role"
                value={filters.role}
                onChange={(e) => setFilter({ role: ROLES.find((r) => r === e.target.value) ?? '' })}
              >
                <option value="">All roles</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </select>
            )}
            <select
              className={SELECT}
              aria-label="File type"
              value={filters.kind}
              onChange={(e) => setFilter({ kind: KINDS.find((k) => k.kind === e.target.value)?.kind ?? '' })}
            >
              <option value="">All file types</option>
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.title}
                </option>
              ))}
            </select>
            {props.analysis !== undefined && (
              <button
                type="button"
                className={BUTTON}
                aria-pressed={proposals}
                title={PROPOSALS_TITLE}
                onClick={() => {
                  restore.current = TOP;
                  setProposals((on) => !on);
                }}
              >
                <Sparkles size={16} aria-hidden className="text-ai" />
                {PROPOSALS_LABEL}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {props.analysis !== undefined && (
                <AnalyseAllButton
                  blocked={withProposals ? PROPOSALS_BLOCK_ANALYSE_ALL : props.analysis.blocked}
                  onClick={() => props.analysis?.onAnalyseAll(toFileQuery(scope, effective))}
                />
              )}
              {VIEWS.map(({ view: v, tooltip, icon: Icon }) => (
                <button
                  key={v}
                  type="button"
                  className={ICON_BUTTON}
                  title={tooltip}
                  aria-label={tooltip}
                  aria-pressed={view === v}
                  onClick={() => switchView(v)}
                >
                  <Icon size={16} aria-hidden />
                </button>
              ))}
            </div>
          </>
          <TagFilter value={filters.tagNames} title="Image tags" onChange={(tagNames) => setFilter({ tagNames })} />
        </FilterBar>
        <div className="flex min-h-0 flex-1 flex-col" aria-busy={paged.pending || undefined}>
          {failedPage !== null ? (
            <div>
              <button type="button" className={BUTTON} onClick={() => paged.retry(failedPage)}>
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
          ) : view === 'grid' ? (
            <FileGridView key={viewKey} {...viewProps} />
          ) : (
            <FileTable key={viewKey} {...viewProps} />
          )}
        </div>
      </div>
      {/* Modal, so its place does not matter; outside the list, focus in it never counts as focus in the list. */}
      {viewerList !== null && viewer?.render(viewerList)}
    </>
  );
}

/** The `data-index` of the item that holds the focus inside `root`, or null. */
function focusedIndex(root: HTMLElement | null): number | null {
  const active = document.activeElement;
  if (root === null || !(active instanceof Element) || !root.contains(active)) return null;
  const value = active.closest('[data-index]')?.getAttribute('data-index');
  const index = value === undefined || value === null ? NaN : Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

