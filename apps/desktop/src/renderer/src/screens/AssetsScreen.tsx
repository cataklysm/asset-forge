import { LayoutGrid, List, Plus, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetStatusSchema, FileRoleSchema, type AssetSummary, type FileKind } from '@assetforge/contracts';
import { call } from '../api';
import { AssetGrid, type AssetViewProps } from '../components/AssetGrid';
import { AssetSelection } from '../components/AssetSelection';
import { AssetTable } from '../components/AssetTable';
import { FilterBar } from '../components/FilterBar';
import { NewAssetDialog } from '../components/NewAssetDialog';
import { Page } from '../components/Page';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { pagesForRows } from '../gallery';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useLoad } from '../hooks/useLoad';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import {
  hasFilters,
  listKey,
  NO_FILTERS,
  readView,
  toAssetQuery,
  writeView,
  type AssetFilters,
  type AssetListState,
  type AssetView,
} from '../list-state';
import { findLoaded, PAGE_SIZE } from '../paged-list';
import { ALERT, BUTTON, ICON_BUTTON, MUTED, SELECT } from '../ui';

const STATUSES = AssetStatusSchema.options;
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

const SKELETON_TILES = 6;

function deviceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface Props {
  state: AssetListState;
  onStateChange(next: AssetListState): void;
  onOpen(id: string): void;
}

export function AssetsScreen({ state, onStateChange, onOpen }: Props) {
  const [view, setView] = useState<AssetView>(() => readView(deviceStorage()));
  const [creating, setCreating] = useState(false);

  const types = useLoad(() => call('assetTypes:list', {}), []);
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);
  // The title shows the size of the whole library, independent of the filters.
  const library = useLoad(() => call('assets:list', { limit: 1, offset: 0 }), []);

  const { filters } = state;
  // Only the text is debounced; selects and tags apply at once. Trimmed before it enters the
  // key, so a trailing space neither waits nor requests anything.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: AssetFilters = { ...filters, query };
  const key = listKey(effective);

  // Where the next mounted view starts; read once by each view when it mounts.
  const restore = useRef<ViewRestore>({
    scrollOffset: state.scrollOffset,
    index: state.openedIndex,
    focus: state.openedIndex !== null,
  });
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) => call('assets:list', { limit, offset, ...toAssetQuery(effective) }),
    // `key` encodes every filter value used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Until the total is known only the page with the item to restore is needed; then the pages
  // of the rows the mounted view renders. Rows reported by another view or list do not count.
  const bootPage = Math.floor((restore.current.index ?? 0) / PAGE_SIZE);
  const [wanted, setWanted] = useState<readonly number[]>([bootPage]);
  const paged = usePagedList<AssetSummary>(key, fetchPage, wanted);
  const total = paged.state.total;
  // Keyed by the displayed list: while a new search loads, the old view stays mounted where it was.
  const viewKey = `${paged.state.key}|${view}`;
  const nextWanted =
    total === null
      ? [bootPage]
      : rows !== null && rows.viewKey === viewKey
        ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
        : [];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  // Leaving the screen another way than by opening an asset still keeps the position.
  const opened = useRef(false);
  const latest = useRef({ state, onStateChange, viewKey });
  latest.current = { state, onStateChange, viewKey };
  useEffect(
    () => () => {
      const current = latest.current;
      if (opened.current || position.current?.viewKey !== current.viewKey) return;
      current.onStateChange({ ...current.state, scrollOffset: position.current.get().scrollOffset, openedIndex: null });
    },
    [],
  );

  // The selected asset as last seen, for when no loaded page holds it (any more).
  const lastSelected = useRef<AssetSummary | null>(null);
  const loadedSelection = findLoaded(paged.state, state.selectedId);
  const selectedAsset =
    loadedSelection?.item ??(lastSelected.current?.id === state.selectedId ? lastSelected.current : null);

  const typeItems = types.data ?? [];
  const typeName = (id: string) => typeItems.find((t) => t.id === id)?.name ?? '–';

  function setFilter(change: Partial<AssetFilters>) {
    restore.current = { scrollOffset: 0, index: null, focus: false };
    onStateChange({ ...state, filters: { ...filters, ...change }, scrollOffset: 0, openedIndex: null });
  }

  function switchView(next: AssetView) {
    if (next === view) return;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    restore.current = { scrollOffset: 0, index: current?.firstIndex ?? null, focus: false };
    writeView(deviceStorage(), next);
    setView(next);
  }

  const onRows = useCallback(
    (visible: VisibleRows) =>
      setRows((old) =>
        old !== null &&
        old.viewKey === viewKey &&
        old.firstRow === visible.firstRow &&
        old.lastRow === visible.lastRow &&
        old.columns === visible.columns
          ? old
          : { ...visible, viewKey },
      ),
    [viewKey],
  );

  function select(_index: number, asset: AssetSummary) {
    lastSelected.current = asset;
    if (state.selectedId !== asset.id) onStateChange({ ...state, selectedId: asset.id });
  }

  function openAsset(index: number | null, asset: AssetSummary, scrollOffset: number) {
    opened.current = true;
    lastSelected.current = asset;
    onStateChange({ ...state, scrollOffset, openedIndex: index, selectedId: asset.id });
    onOpen(asset.id);
  }

  function openSelected() {
    if (selectedAsset === null) return;
    const scrollOffset = position.current?.viewKey === viewKey ? position.current.get().scrollOffset : state.scrollOffset;
    openAsset(loadedSelection?.index ?? null, selectedAsset, scrollOffset);
  }

  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;
  const filtered = hasFilters(effective);
  const viewProps: AssetViewProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore: restore.current,
          typeName,
          selectedId: state.selectedId,
          onSelect: select,
          onOpen: openAsset,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
        };
  const errors = [types.error, projects.error].filter((e): e is string => e !== null);

  const toolbar = (
    <div className="flex flex-col gap-3">
      <FilterBar
        resultCount={total === null ? null : `${total} ${total === 1 ? 'asset' : 'assets'}`}
        onClear={hasFilters(filters) ? () => setFilter(NO_FILTERS) : null}
      >
        <>
          <SearchField
            label="Search assets"
            placeholder="Search assets"
            value={filters.query}
            onChange={(text) => setFilter({ query: text })}
          />
          <select
            className={SELECT}
            aria-label="Type"
            value={filters.typeId}
            onChange={(e) => setFilter({ typeId: e.target.value })}
          >
            <option value="">All types</option>
            {typeItems.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            className={SELECT}
            aria-label="Status"
            value={filters.status}
            onChange={(e) => setFilter({ status: STATUSES.find((s) => s === e.target.value) ?? '' })}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select
            className={SELECT}
            aria-label="Project"
            value={filters.projectId}
            onChange={(e) => setFilter({ projectId: e.target.value })}
          >
            <option value="">All projects</option>
            {(projects.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
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
        <>
          <TagFilter
            value={filters.tagNames}
            title="Assets that carry all these tags, on the asset or on one of its files"
            onChange={(tagNames) => setFilter({ tagNames })}
          />
          <select
            className={SELECT}
            aria-label="Role"
            title="Assets with a file in this role"
            value={filters.fileRole}
            onChange={(e) => setFilter({ fileRole: ROLES.find((r) => r === e.target.value) ?? '' })}
          >
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
          <select
            className={SELECT}
            aria-label="File type"
            title="Assets with a file of this type"
            value={filters.fileKind}
            onChange={(e) => setFilter({ fileKind: KINDS.find((k) => k.kind === e.target.value)?.kind ?? '' })}
          >
            <option value="">All file types</option>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.title}
              </option>
            ))}
          </select>
        </>
      </FilterBar>
      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
    </div>
  );

  return (
    <Page
      title="Assets"
      count={library.data?.total ?? null}
      countTitle="Assets in the library"
      actions={
        <button type="button" className={BUTTON} onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden />
          New asset
        </button>
      }
      toolbar={toolbar}
      detail={<AssetSelection asset={selectedAsset} typeName={typeName} onOpen={openSelected} />}
    >
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
              <div key={i} data-skeleton="" className="h-[320px] w-[240px] animate-pulse rounded-tile bg-raised" />
            ))}
          </div>
        ) : viewProps === null ? (
          <p className={MUTED}>{filtered ? 'No matching assets' : 'No assets'}</p>
        ) : view === 'grid' ? (
          <AssetGrid key={viewKey} {...viewProps} />
        ) : (
          <AssetTable key={viewKey} {...viewProps} />
        )}
      </div>
      <NewAssetDialog
        open={creating}
        types={typeItems}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </Page>
  );
}
