import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AssetStatusSchema, type AssetSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetGrid, type AssetViewProps } from '../components/AssetGrid';
import { AssetTable } from '../components/AssetTable';
import { pagesForRows } from '../gallery';
import { usePagedList } from '../hooks/usePagedList';
import { useLoad } from '../hooks/useLoad';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import {
  filterKey,
  readView,
  writeView,
  type AssetFilters,
  type AssetListState,
  type AssetView,
} from '../list-state';
import { PAGE_SIZE } from '../paged-list';
import { ALERT, BUTTON, INPUT, MUTED } from '../ui';

const STATUSES = AssetStatusSchema.options;

const VIEWS = [
  { view: 'grid', title: 'Grid', tooltip: 'Show as tiles' },
  { view: 'table', title: 'Table', tooltip: 'Show as table' },
] satisfies { view: AssetView; title: string; tooltip: string }[];

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
  const [newName, setNewName] = useState('');
  const [newTypeId, setNewTypeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const types = useLoad(() => call('assetTypes:list', {}), []);
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);

  const { filters } = state;
  const trimmed: AssetFilters = { ...filters, query: filters.query.trim() };
  const key = filterKey(trimmed);
  const viewKey = `${key}|${view}`;

  // Where the next mounted view starts; read once by each view when it mounts.
  const restore = useRef<ViewRestore>({
    scrollOffset: state.scrollOffset,
    index: state.openedIndex,
    focus: state.openedIndex !== null,
  });
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      call('assets:list', {
        limit,
        offset,
        ...(trimmed.typeId !== '' && { typeId: trimmed.typeId }),
        ...(trimmed.status !== '' && { status: AssetStatusSchema.parse(trimmed.status) }),
        ...(trimmed.projectId !== '' && { projectId: trimmed.projectId }),
        ...(trimmed.query !== '' && { query: trimmed.query }),
      }),
    // `key` encodes every filter value used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Until the total is known only the page with the item to restore is needed; then the pages
  // of the rows the mounted view renders. Rows reported by another view or filter do not count.
  const bootPage = Math.floor((restore.current.index ?? 0) / PAGE_SIZE);
  const [wanted, setWanted] = useState<readonly number[]>([bootPage]);
  const paged = usePagedList<AssetSummary>(key, fetchPage, wanted);
  const total = paged.state.total;
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

  const typeItems = types.data ?? [];
  const typeName = (id: string) => typeItems.find((t) => t.id === id)?.name ?? '–';
  const effectiveNewType = newTypeId !== '' ? newTypeId : (typeItems[0]?.id ?? '');

  function setFilter(change: Partial<AssetFilters>) {
    restore.current = { scrollOffset: 0, index: null, focus: false };
    onStateChange({ filters: { ...filters, ...change }, scrollOffset: 0, openedIndex: null });
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

  function openAsset(index: number, asset: AssetSummary, scrollOffset: number) {
    opened.current = true;
    onStateChange({ ...state, scrollOffset, openedIndex: index });
    onOpen(asset.id);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (newName.trim() === '' || effectiveNewType === '') return;
    setCreating(true);
    setCreateError(null);
    try {
      const asset = await call('assets:create', { name: newName.trim(), typeId: effectiveNewType });
      opened.current = true;
      onOpen(asset.id);
    } catch (e) {
      setCreateError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  const errors = [types.error, projects.error].filter((e): e is string => e !== null);
  const bootFailed = total === null && paged.state.pages.get(bootPage)?.status === 'failed';
  const viewProps: AssetViewProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore: restore.current,
          typeName,
          onOpen: openAsset,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
        };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="Assets">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void create(e)}>
        <input
          className={INPUT}
          aria-label="Asset name"
          placeholder="Asset name"
          value={newName}
          maxLength={200}
          onChange={(e) => setNewName(e.target.value)}
        />
        <select
          className={INPUT}
          aria-label="Asset type"
          value={effectiveNewType}
          onChange={(e) => setNewTypeId(e.target.value)}
        >
          {typeItems.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className={BUTTON}
          disabled={creating || newName.trim() === '' || effectiveNewType === ''}
        >
          Create
        </button>
      </form>
      {createError !== null && (
        <p role="alert" className={ALERT}>
          {createError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={INPUT}
          aria-label="Filter by type"
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
          className={INPUT}
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) => setFilter({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          className={INPUT}
          aria-label="Filter by project"
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
        <input
          className={INPUT}
          aria-label="Filter by name"
          placeholder="Name"
          value={filters.query}
          onChange={(e) => setFilter({ query: e.target.value })}
        />
        <div className="ml-auto flex items-center gap-2">
          {total !== null && (
            <span className={`text-sm ${MUTED}`} aria-live="polite">
              {total} {total === 1 ? 'asset' : 'assets'}
            </span>
          )}
          {VIEWS.map((v) => (
            <button
              key={v.view}
              type="button"
              className={BUTTON}
              title={v.tooltip}
              aria-pressed={view === v.view}
              onClick={() => switchView(v.view)}
            >
              {v.title}
            </button>
          ))}
        </div>
      </div>

      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}

      {bootFailed ? (
        <div>
          <button type="button" className={BUTTON} onClick={() => paged.retry(bootPage)}>
            Retry
          </button>
        </div>
      ) : total === null ? (
        <p className={MUTED}>Loading…</p>
      ) : viewProps === null ? (
        <p className={MUTED}>No assets found.</p>
      ) : view === 'grid' ? (
        <AssetGrid key={viewKey} {...viewProps} />
      ) : (
        <AssetTable key={viewKey} {...viewProps} />
      )}
    </section>
  );
}
