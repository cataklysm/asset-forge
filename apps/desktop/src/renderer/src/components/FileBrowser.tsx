import { LayoutGrid, List, Search, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import { FileRoleSchema, type FileKind, type FileRecord, type FileScope } from '@assetforge/contracts';
import { call } from '../api';
import { columnsForWidth, pagesForRows, rowItems } from '../gallery';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import { label } from '../labels';
import { hasFilters, listKey, NO_FILE_FILTERS, toFileQuery, type AssetView, type FileFilters } from '../list-state';
import { PAGE_SIZE, retryIndex, slotAt, type PagedState } from '../paged-list';
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
import { BUTTON, FOCUS, ICON_BUTTON, ITEM_HOVER, MUTED, SELECT, TILE_TITLE } from '../ui';
import { FileTable } from './FileTable';
import { FileFrame, fileItemHandlers, fileMeta, ITEM_CONTROL, SelectBox, type FileViewProps } from './FileTile';
import { FilterBar } from './FilterBar';
import { Menu, type MenuItem } from './Menu';
import { SearchField } from './SearchField';
import { TagFilter } from './TagFilter';
import { TagList } from './TagList';

const ROLES = FileRoleSchema.options;
const KINDS: { kind: FileKind; title: string }[] = [
  { kind: 'image', title: 'Image' },
  { kind: 'model', title: '3D model' },
  { kind: 'document', title: 'Document' },
  { kind: 'other', title: 'Other' },
];

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
  /** Part of the list key; bump after a mutation to refetch. The position is kept. */
  reloadToken: number;
  /** Shows the "Cover" badge on this file. */
  coverFileId?: string | null;
  /** Enter, double click, the magnifier and the host's "Details" menu item. */
  onOpen(file: FileRecord): void;
  /** The tile "…" menu; no menu without items. */
  menuItems(file: FileRecord): MenuItem[];
  /** Shown when the unfiltered list is empty ("No files" / "Inbox is empty"). */
  emptyText: string;
  /** Shown below `emptyText` (e.g. the inbox's "Import files"). */
  emptyAction?: ReactNode;
  onTotal?(total: number | null): void;
}

/**
 * A paginated, virtualised list of files as tiles or a table, with its filters, endless
 * scrolling and multi-select (see `selection.ts`). Mounted by the asset Files tab and the inbox.
 */
export function FileBrowser(props: FileBrowserProps) {
  const { scope, filters, onFiltersChange, showRoleFilter, view, onViewChange, selection, reloadToken, emptyText } = props;
  const showRole = scope.kind === 'asset';

  // Only the text is debounced, trimmed before it enters the key; the role is ignored while hidden.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: FileFilters = { ...filters, query, role: showRoleFilter ? filters.role : '' };
  const scopeText = JSON.stringify(scope);
  const filterKey = listKey(effective, scopeText);
  const key = listKey(effective, JSON.stringify([scope, reloadToken]));

  const containerRef = useRef<HTMLDivElement>(null);
  const restore = useRef<ViewRestore>(props.restore ?? TOP);
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) => call('files:list', { limit, offset, ...toFileQuery(scope, effective) }),
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

  const nextWanted =
    total === null
      ? [bootPage]
      : rows !== null && rows.viewKey === viewKey
        ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
        : [];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  const latest = useRef({ props, viewKey, paged });
  latest.current = { props, viewKey, paged };

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
        };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3">
      <FilterBar
        resultCount={total === null ? null : `${total} ${total === 1 ? 'file' : 'files'}`}
        countTitle={total !== null && total > MAX_SELECTION ? `At most ${MAX_SELECTION} files can be selected` : undefined}
        onClear={hasFilters(showRoleFilter ? filters : { ...filters, role: '' }) ? () => setFilter(NO_FILE_FILTERS) : null}
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
          <div className="ml-auto flex items-center gap-2">
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
          hasFilters(effective) || props.emptyAction === undefined ? (
            <p className={MUTED}>{hasFilters(effective) ? 'No matching files' : emptyText}</p>
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

const TILE_WIDTH = 200;
const FRAME_HEIGHT = 150;
const GAP = 16;
// Frame (150) + padding 12 + name 24 + meta 20 + 8 + chips 26 + padding 12 = 252.
const TILE_HEIGHT = 260;
const ROW_HEIGHT = TILE_HEIGHT + GAP;
// Room for the focus ring of the first row and column.
const EDGE = 4;
// The "Cover" badge: chip geometry on an opaque background, readable over the thumbnail.
const BADGE =
  'inline-flex h-[26px] items-center rounded-control border border-line-strong bg-surface px-2.5 text-[13px] text-text';
// Shows the magnifier while the pointer is over the tile or focus is inside it.
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

function FileGridView(props: FileViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const columns = size === null ? 1 : columnsForWidth(size.width - 2 * EDGE, TILE_WIDTH, GAP);
  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Files"
      aria-multiselectable="true"
      className="min-h-0 flex-1 select-none overflow-y-scroll"
    >
      {size !== null && size.height > 0 && (
        <GridRows {...props} scrollRef={scrollRef} columns={columns} height={size.height} />
      )}
    </div>
  );
}

function GridRows(
  props: FileViewProps & { scrollRef: RefObject<HTMLDivElement | null>; columns: number; height: number },
) {
  const { viewKey, paged, total, restore, onRows, onRetry, positionRef, scrollRef, columns, height } = props;
  const rows = useVirtualRows({
    scrollRef,
    total,
    columns,
    rowHeight: ROW_HEIGHT,
    paddingStart: EDGE,
    viewportHeight: height,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;
  const items = virtualizer.getVirtualItems();

  return (
    <div role="presentation" className="relative w-full" style={{ height: virtualizer.getTotalSize() + EDGE }}>
      {items.map((row) => {
        const { start, end } = rowItems(row.index, columns, total);
        const indexes = Array.from({ length: end - start }, (_, i) => start + i);
        // No overflow clipping here or on the tiles: a tile's menu extends below its row.
        return (
          <div
            key={row.index}
            role="presentation"
            className="absolute flex"
            style={{ top: row.start, left: EDGE, height: ROW_HEIGHT, gap: GAP }}
          >
            {indexes.map((index) => (
              <GridItem key={index} {...props} rows={rows} index={index} paged={paged} onRetry={onRetry} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function GridItem(
  props: FileViewProps & { rows: ReturnType<typeof useVirtualRows>; index: number; paged: PagedState<FileRecord> },
) {
  const { rows, index, paged, total, showRole, coverFileId, selected, onRetry } = props;
  const slot = slotAt(paged, index);
  const tabbable = index === rows.tabbableIndex;
  if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
    return (
      <div
        role="presentation"
        className="flex items-center justify-center"
        style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      >
        <button
          type="button"
          data-index={index}
          className={BUTTON}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => {
            rows.refocus(index);
            onRetry(slot.page);
          }}
          onKeyDown={(e) => rows.onItemKeyDown(index, e)}
          onFocus={() => rows.onItemFocus(index)}
        >
          Retry
        </button>
      </div>
    );
  }
  const file = slot.kind === 'loaded' ? slot.item : null;
  const isSelected = file !== null && selected.has(file.id);
  const menuItems = file === null ? [] : props.menuItems(file);
  return (
    <div
      role="option"
      data-index={index}
      data-file-tile={file === null ? undefined : ''}
      data-file-id={file?.id}
      aria-setsize={total}
      aria-posinset={index + 1}
      tabIndex={tabbable ? 0 : -1}
      aria-selected={isSelected}
      aria-disabled={file === null ? true : undefined}
      aria-busy={slot.kind === 'placeholder' ? true : undefined}
      title={file?.originalName}
      className={`group relative cursor-default rounded-tile border-2 bg-surface ${
        isSelected ? 'border-accent' : 'border-transparent'
      } ${ITEM_HOVER} ${FOCUS}`}
      style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      {...fileItemHandlers(props, rows, index, file)}
    >
      {file === null ? (
        <div className="animate-pulse rounded-t-tile bg-raised" style={{ height: FRAME_HEIGHT }} />
      ) : (
        <>
          <div className="overflow-hidden rounded-t-tile" style={{ height: FRAME_HEIGHT }}>
            <FileFrame file={file} className="h-full w-full" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: FRAME_HEIGHT }}>
            <span className="pointer-events-auto absolute left-2 top-2 flex rounded-control bg-surface/85 p-1">
              <SelectBox file={file} index={index} checked={isSelected} onToggle={props.onToggle} />
            </span>
            {menuItems.length > 0 && (
              <span {...ITEM_CONTROL} className="pointer-events-auto absolute right-2 top-2">
                <Menu label="File actions" items={menuItems} tabIndex={tabbable ? 0 : -1} />
              </span>
            )}
            <button
              {...ITEM_CONTROL}
              type="button"
              tabIndex={-1}
              aria-label="Details"
              title="Details"
              className={`pointer-events-auto absolute bottom-2 right-2 ${ICON_BUTTON} ${REVEAL}`}
              onClick={() => props.onOpen(file)}
            >
              <Search size={16} aria-hidden />
            </button>
            {file.id === coverFileId && <span className={`absolute bottom-2 left-2 ${BADGE}`}>Cover</span>}
          </div>
          <div className="px-3 py-3">
            <p className={`leading-6 ${TILE_TITLE}`}>{file.originalName}</p>
            <p className={`truncate text-sm leading-5 ${MUTED}`}>{fileMeta(file, showRole)}</p>
            <div className="mt-2">
              <TagList tags={file.tags} kind="file" max={3} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
