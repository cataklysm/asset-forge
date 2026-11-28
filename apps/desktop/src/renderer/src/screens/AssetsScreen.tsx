import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetSummary } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call } from '../api';
import { useAnalysisDialogs } from '../components/AnalysisDialogs';
import { AssetGrid, type AssetViewProps } from '../components/AssetGrid';
import { AssetSelection } from '../components/AssetSelection';
import { AssetTable } from '../components/AssetTable';
import { AssetToolbar } from '../components/AssetToolbar';
import { NewAssetDialog } from '../components/NewAssetDialog';
import { Page } from '../components/Page';
import { pagesForRows } from '../gallery';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useLoad } from '../hooks/useLoad';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import {
  hasFilters,
  listKey,
  readView,
  toAssetQuery,
  writeView,
  type AssetFilters,
  type AssetListState,
  type AssetView,
} from '../list-state';
import { findLoaded, PAGE_SIZE } from '../paged-list';
import { renameInTags } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { BUTTON, MUTED } from '../ui';

// The asset gallery: filters, a virtualised grid or table with endless paging, and the Selection column.

const SKELETON_TILES = 6;

/** The rows the mounted view renders, with the view they belong to. */
type ViewRows = VisibleRows & { viewKey: string };

/**
 * The browser's local storage, if it can be reached.
 *
 * @returns the storage, or null when the browser refuses it
 */
function deviceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The pages the list needs: until the total is known only the page with the item to restore; then the pages of
 * the rows the mounted view renders. Rows reported by another view or list do not count.
 *
 * @param total the list's total; null until known
 * @param rows the rows last reported
 * @param viewKey the displayed view
 * @param bootPage the page with the item to restore
 * @returns the wanted page indexes
 */
function wantedPages(total: number | null, rows: ViewRows | null, viewKey: string, bootPage: number): number[] {
  if (total === null) return [bootPage];
  if (rows !== null && rows.viewKey === viewKey) return pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total);
  return [];
}

/** The props of the gallery. */
interface Props {
  /** Filters, scroll offset, opened index and selection; kept by the shell so that they survive navigation. */
  state: AssetListState;
  /** Hands a changed state to the shell. */
  onStateChange(next: AssetListState): void;
  /** Opens an asset. */
  onOpen(id: string): void;
}

/**
 * The asset gallery.
 *
 * @param props the kept list state, its change and the open action
 * @returns the screen
 */
export function AssetsScreen({ state, onStateChange, onOpen }: Props) {
  const [view, setView] = useState<AssetView>(() => readView(deviceStorage()));
  const [creating, setCreating] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  // The gallery lists assets, not proposals: an accepted or discarded proposal changes nothing here.
  const analysis = useAnalysisDialogs({ onStarted: (result) => setStarted(enqueueTitle(result)), onChanged: () => {} });

  const types = useLoad(() => call('assetTypes:list', {}), []);
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);
  // The title shows the size of the whole library, independent of the filters.
  const library = useLoad(() => call('assets:list', { limit: 1, offset: 0 }), []);

  const { filters } = state;
  // Only the text is debounced; selects and tags apply at once. Trimmed before it enters the
  // key, so a trailing space neither waits nor requests anything.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: AssetFilters = { ...filters, query };
  // A tag rename changes what the assets carry and what matches: the list reloads.
  const { renameToken } = useTags();
  const key = listKey(effective, String(renameToken));

  // Where the next mounted view starts; read once by each view when it mounts.
  const restore = useRef<ViewRestore>({
    scrollOffset: state.scrollOffset,
    index: state.openedIndex,
    focus: state.openedIndex !== null,
  });
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const lastToken = useRef(renameToken);
  const [rows, setRows] = useState<ViewRows | null>(null);

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
  /** The mounted view's position, when it is the displayed one. */
  const currentPosition = () => (position.current?.viewKey === viewKey ? position.current.get() : null);
  // The view reloaded after a rename starts where the displayed one is now.
  if (lastToken.current !== renameToken) {
    lastToken.current = renameToken;
    const current = currentPosition();
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: null, focus: false };
  }
  const nextWanted = wantedPages(total, rows, viewKey, bootPage);
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
  // The reload reaches the loaded pages; this copy follows the rename here.
  useRenamed((change) => {
    const asset = lastSelected.current;
    if (asset === null) return;
    const tags = renameInTags(asset.tags, change);
    const coverTags = renameInTags(asset.coverTags, change);
    if (tags !== asset.tags || coverTags !== asset.coverTags)
      lastSelected.current = { ...asset, tags: [...tags], coverTags: [...coverTags] };
  });
  const loadedSelection = findLoaded(paged.state, state.selectedId);
  // A loaded page holds the newest copy, also of an asset selected before this mount.
  if (loadedSelection !== null) lastSelected.current = loadedSelection.item;
  const selectedAsset =
    loadedSelection?.item ?? (lastSelected.current?.id === state.selectedId ? lastSelected.current : null);

  const typeItems = types.data ?? [];
  const typeName = (id: string) => typeItems.find((type) => type.id === id)?.name ?? '–';

  /** Changes some filters; the list starts at the top. */
  function setFilter(change: Partial<AssetFilters>) {
    restore.current = { scrollOffset: 0, index: null, focus: false };
    onStateChange({ ...state, filters: { ...filters, ...change }, scrollOffset: 0, openedIndex: null });
  }

  /** Switches the view; the new one starts at the first item the old one showed, and the choice is kept on the device. */
  function switchView(next: AssetView) {
    if (next === view) return;
    const current = currentPosition();
    restore.current = { scrollOffset: 0, index: current?.firstIndex ?? null, focus: false };
    writeView(deviceStorage(), next);
    setView(next);
  }

  const onRows = useCallback(
    (visible: VisibleRows) =>
      setRows((previous) =>
        previous !== null &&
        previous.viewKey === viewKey &&
        previous.firstRow === visible.firstRow &&
        previous.lastRow === visible.lastRow &&
        previous.columns === visible.columns
          ? previous
          : { ...visible, viewKey },
      ),
    [viewKey],
  );

  /** Selects an asset for the Selection column. */
  function select(_index: number, asset: AssetSummary) {
    lastSelected.current = asset;
    if (state.selectedId !== asset.id) onStateChange({ ...state, selectedId: asset.id });
  }

  /** Opens an asset; the shell keeps where the gallery was. */
  function openAsset(index: number | null, asset: AssetSummary, scrollOffset: number) {
    opened.current = true;
    lastSelected.current = asset;
    onStateChange({ ...state, scrollOffset, openedIndex: index, selectedId: asset.id });
    onOpen(asset.id);
  }

  /** Opens the selected asset from the Selection column. */
  function openSelected() {
    if (selectedAsset === null) return;
    const scrollOffset =
      position.current?.viewKey === viewKey ? position.current.get().scrollOffset : state.scrollOffset;
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
  const errors = [types.error, projects.error].filter((message): message is string => message !== null);

  const toolbar = (
    <AssetToolbar
      filters={filters}
      onFilterChange={setFilter}
      types={typeItems}
      projects={projects.data?.items ?? []}
      analysisBlocked={analysis.blocked}
      onAnalyseAll={() => analysis.start({ kind: 'assetFilter', filter: toAssetQuery(effective) })}
      view={view}
      onSwitchView={switchView}
      total={total}
      errors={errors}
      started={started}
      onDismissStarted={() => setStarted(null)}
    />
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
      detail={
        <AssetSelection
          asset={selectedAsset}
          typeName={typeName}
          onOpen={openSelected}
          analyseBlocked={analysis.blocked}
          onAnalyse={(assetId) => analysis.start({ kind: 'asset', assetId })}
        />
      }
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
      {analysis.dialogs}
    </Page>
  );
}
