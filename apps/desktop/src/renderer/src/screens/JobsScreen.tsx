import { RotateCcw, X } from 'lucide-react';
import { useCallback, useRef, useState, type RefObject } from 'react';
import { ACTIVE_JOB_STATUSES, ANALYZE_FILE_JOB, type JobStatus, type JobView, type ProviderList } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { FilterBar } from '../components/FilterBar';
import { laneName, MoveJobsDialog } from '../components/MoveJobsDialog';
import { Page } from '../components/Page';
import { formatDateTime } from '../format';
import { pagesForRows, rowCount } from '../gallery';
import { usePagedList } from '../hooks/usePagedList';
import {
  useElementSize,
  useVirtualRows,
  type ViewHandle,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import { useJobs } from '../jobs-context';
import {
  ALL_PROVIDERS,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  JOBS_PROVIDER_HEADER,
  jobStatusLabel,
  MOVE_JOBS_LABEL,
  MOVE_JOBS_TITLE,
} from '../labels';
import { useProviders } from '../provider-context';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { ALERT, BORDER, BUTTON, BUTTON_INLINE, ICON_BUTTON, ITEM_HOVER, MUTED, SELECT } from '../ui';

/** The scheduler's `MAX_ATTEMPTS` (packages/jobs), which the renderer does not import. */
const MAX_ATTEMPTS = 3;
const STATUSES = Object.keys(JOB_STATUS_LABELS) as JobStatus[];
const CANCELLABLE: ReadonlySet<JobStatus> = new Set(ACTIVE_JOB_STATUSES);
const RETRYABLE: ReadonlySet<JobStatus> = new Set(['failed', 'cancelled']);
const TOP: ViewRestore = { scrollOffset: 0, index: null, focus: false };
const SKELETON_ROWS = 6;

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const COLUMNS =
  'grid grid-cols-[9rem_minmax(8rem,1.2fr)_minmax(8rem,1fr)_6rem_5rem_10rem_minmax(8rem,1.5fr)_2.5rem] items-center gap-3 px-2';
const HEADERS = ['Job', 'File', JOBS_PROVIDER_HEADER, 'Status', 'Attempt', 'Created', 'Error'];

function jobLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}

/** The index of the row that holds the focus inside `root`, or null. */
function focusedIndex(root: HTMLElement | null): number | null {
  const active = document.activeElement;
  if (root === null || !(active instanceof Element) || !root.contains(active)) return null;
  const value = active.closest('[data-index]')?.getAttribute('data-index');
  const index = value === undefined || value === null ? NaN : Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The jobs of the workspace, newest first, with a status filter, row and page actions. */
export function JobsScreen() {
  const { summary, active, changeToken, refresh } = useJobs();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const providers = useProviders();
  const entries = providers.list?.providers ?? [];
  // The chosen provider filter; '' (all) once its entry is no longer listed.
  const [chosenProvider, setChosenProvider] = useState('');
  const providerId = entries.some((p) => p.id === chosenProvider) ? chosenProvider : '';
  const [moving, setMoving] = useState(false);
  // Bumped after every action of this screen; with `changeToken` it reloads the list.
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const reloadKey = `${changeToken}|${reloadToken}`;
  const key = JSON.stringify([status, providerId, reloadKey]);

  const containerRef = useRef<HTMLDivElement>(null);
  // Where the next mounted table starts; read once by each table when it mounts.
  const restore = useRef<ViewRestore>(TOP);
  const position = useRef<ViewHandle | null>(null);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      call('jobs:list', {
        limit,
        offset,
        ...(status === '' ? {} : { status }),
        ...(providerId === '' ? {} : { providerId }),
      }),
    [status, providerId],
  );

  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<JobView>(key, fetchPage, wanted);
  const total = paged.state.total;
  // Keyed by the displayed list: while a reload is pending, the old table stays where it was.
  const viewKey = paged.state.key;

  // A reload keeps the position and the focused row: the table remounts with the new list.
  const lastReload = useRef(reloadKey);
  if (lastReload.current !== reloadKey) {
    lastReload.current = reloadKey;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    const focused = focusedIndex(containerRef.current);
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: focused, focus: focused !== null };
  }

  const nextWanted =
    total === null
      ? [0]
      : rows !== null && rows.viewKey === viewKey
        ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
        : [];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

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

  function chooseStatus(value: string) {
    restore.current = TOP;
    setStatus(STATUSES.find((s) => s === value) ?? '');
  }

  function chooseProvider(value: string) {
    restore.current = TOP;
    setChosenProvider(value);
  }

  async function run(action: () => Promise<unknown>) {
    // One action at a time; the ref also catches a second click before the busy render.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh();
      setReloadToken((n) => n + 1);
    }
  }

  const finished = summary === null ? 0 : summary.succeeded + summary.failed + summary.cancelled;
  const retryable = summary === null ? 0 : summary.failed + summary.cancelled;
  const actions = (
    <>
      <button type="button" className={BUTTON} title={MOVE_JOBS_TITLE} onClick={() => setMoving(true)}>
        {MOVE_JOBS_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || summary === null || active === 0}
        onClick={() => void run(() => call('jobs:cancelAll', {}))}
      >
        Cancel all
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || retryable === 0}
        onClick={() => void run(() => call('jobs:retryFailed', {}))}
      >
        Retry failed
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || finished === 0}
        onClick={() => void run(() => call('jobs:clearFinished', {}))}
      >
        Clear finished
      </button>
    </>
  );

  const toolbar = (
    <FilterBar resultCount={null} onClear={null}>
      <select className={SELECT} aria-label="Status" value={status} onChange={(e) => chooseStatus(e.target.value)}>
        <option value="">All</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {jobStatusLabel(s)}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        aria-label={JOBS_PROVIDER_HEADER}
        value={providerId}
        onChange={(e) => chooseProvider(e.target.value)}
      >
        <option value="">{ALL_PROVIDERS}</option>
        {entries.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </FilterBar>
  );

  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;

  return (
    <Page title="Jobs" count={total} countTitle="Jobs in this workspace" actions={actions} toolbar={toolbar}>
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3" aria-busy={paged.pending || undefined}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {failedPage !== null ? (
          <div>
            <button type="button" className={BUTTON} onClick={() => paged.retry(failedPage)}>
              Retry
            </button>
          </div>
        ) : total === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div key={i} data-skeleton="" className="h-10 animate-pulse rounded-control bg-raised" />
            ))}
          </div>
        ) : total === 0 ? (
          <p className={MUTED}>No jobs</p>
        ) : (
          <JobTable
            key={viewKey}
            viewKey={viewKey}
            paged={paged.state}
            total={total}
            restore={restore.current}
            onRows={onRows}
            onRetry={paged.retry}
            positionRef={position}
            onCancel={(job) => void run(() => call('jobs:cancel', { jobId: job.id }))}
            onRetryJob={(job) => void run(() => call('jobs:retry', { jobId: job.id }))}
          />
        )}
      </div>
      {moving && (
        <MoveJobsDialog
          source={undefined}
          onClose={() => {
            setMoving(false);
            setReloadToken((n) => n + 1);
          }}
        />
      )}
    </Page>
  );
}

interface JobTableProps {
  viewKey: string;
  paged: PagedState<JobView>;
  total: number;
  restore: ViewRestore;
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: ViewHandle | null };
  onCancel(job: JobView): void;
  onRetryJob(job: JobView): void;
}

function JobTable(props: JobTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Jobs"
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <JobRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

function JobRows(props: JobTableProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const { viewKey, paged, total, restore, onRows, onRetry, positionRef, onCancel, onRetryJob } = props;
  const rows = useVirtualRows({
    scrollRef: props.scrollRef,
    total,
    columns: 1,
    rowHeight: ROW_HEIGHT,
    paddingStart: HEADER_HEIGHT,
    viewportHeight: props.height - HEADER_HEIGHT,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;

  return (
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      <div
        role="row"
        aria-rowindex={1}
        className={`sticky top-0 z-10 border-b bg-surface ${BORDER} ${MUTED} ${COLUMNS}`}
        style={{ height: HEADER_HEIGHT }}
      >
        {HEADERS.map((header) => (
          <span key={header} role="columnheader" className="truncate">
            {header}
          </span>
        ))}
        <span role="columnheader" aria-label="Actions" />
      </div>
      {virtualizer.getVirtualItems().map((row) => {
        const index = row.index;
        const slot = slotAt(paged, index);
        const style = { top: row.start, height: ROW_HEIGHT };
        const tabbable = index === rows.tabbableIndex;
        if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
          return (
            <div
              key={index}
              role="row"
              aria-rowindex={index + 2}
              className={`absolute inset-x-0 flex items-center border-b px-2 ${BORDER}`}
              style={style}
            >
              <span role="gridcell">
                <button
                  type="button"
                  data-index={index}
                  className={BUTTON_INLINE}
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
              </span>
            </div>
          );
        }
        const job = slot.kind === 'loaded' ? slot.item : null;
        return (
          <div
            key={index}
            role="row"
            aria-rowindex={index + 2}
            data-index={index}
            tabIndex={tabbable ? 0 : -1}
            aria-disabled={job === null ? true : undefined}
            aria-busy={slot.kind === 'placeholder' ? true : undefined}
            className={`absolute inset-x-0 cursor-default border-b ${BORDER} ${ITEM_HOVER} ${ROW_FOCUS} ${COLUMNS}`}
            style={style}
            onKeyDown={(e) => rows.onItemKeyDown(index, e)}
            onFocus={() => rows.onItemFocus(index)}
          >
            {job !== null && (
              <JobCells job={job} tabIndex={tabbable ? 0 : -1} onCancel={() => onCancel(job)} onRetry={() => onRetryJob(job)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The provider of an analysis job: the current entry name (or the stored one) and the model; '—' for other jobs. */
function providerText(list: ProviderList | null, job: JobView): string {
  if (job.type !== ANALYZE_FILE_JOB) return '—';
  const name = laneName(list, job.providerId, job.providerName);
  return job.model === null ? name : `${name} · ${job.model}`;
}

function JobCells({ job, tabIndex, onCancel, onRetry }: { job: JobView; tabIndex: number; onCancel(): void; onRetry(): void }) {
  const { list } = useProviders();
  const provider = providerText(list, job);
  const waitTitle =
    job.status === 'retry_wait' && job.runAfter !== null ? `Next try at ${formatDateTime(job.runAfter)}` : undefined;
  return (
    <>
      <span role="gridcell" className="truncate">
        {jobLabel(job.type)}
      </span>
      <span role="gridcell" className="truncate font-medium" title={job.fileName ?? undefined}>
        {job.fileName ?? '—'}
      </span>
      <span role="gridcell" className="truncate" title={provider}>
        {provider}
      </span>
      <span role="gridcell" className={`truncate ${job.status === 'failed' ? 'text-danger' : ''}`} title={waitTitle}>
        {jobStatusLabel(job.status)}
      </span>
      <span role="gridcell" className="truncate tabular-nums">
        {`${job.attempt} / ${MAX_ATTEMPTS}`}
      </span>
      <span role="gridcell" className="truncate">
        {formatDateTime(job.createdAt)}
      </span>
      <span role="gridcell" className={`truncate ${MUTED}`} title={job.errorMessage ?? undefined}>
        {job.errorMessage ?? ''}
      </span>
      <span role="gridcell" className="flex justify-end">
        {CANCELLABLE.has(job.status) && (
          <button
            type="button"
            className={ICON_BUTTON}
            tabIndex={tabIndex}
            title="Cancel job"
            aria-label="Cancel job"
            onClick={onCancel}
          >
            <X size={16} aria-hidden />
          </button>
        )}
        {RETRYABLE.has(job.status) && (
          <button
            type="button"
            className={ICON_BUTTON}
            tabIndex={tabIndex}
            title="Retry job"
            aria-label="Retry job"
            onClick={onRetry}
          >
            <RotateCcw size={16} aria-hidden />
          </button>
        )}
      </span>
    </>
  );
}
