import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  MAX_CHOSEN_IDS,
  type Changes,
  type JobStatus,
  type JobSummary,
  type JobView,
  type ProviderList,
} from '@assetforge/contracts';
import { call, describeError } from '../api';
import { FilterBar } from '../components/FilterBar';
import { JobTable, type JobTableProps } from '../components/JobTable';
import { MoveJobsDialog } from '../components/MoveJobsDialog';
import { Page } from '../components/Page';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewHandle, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { useChanges, useJobs } from '../jobs-context';
import {
  ALL_PROVIDERS,
  ALL_STATUSES,
  CANCEL_ALL_LABEL,
  CLEAR_FINISHED_LABEL,
  JOB_STATUS_LABELS,
  JOBS_COUNT_TITLE,
  JOBS_PROVIDER_HEADER,
  JOBS_STATUS_LABEL,
  JOBS_TITLE,
  jobCount,
  jobStatusLabel,
  MOVE_JOBS_LABEL,
  MOVE_JOBS_TITLE,
  NO_JOBS,
  RETRY_FAILED_LABEL,
  RETRY_LABEL,
} from '../labels';
import { useProviders } from '../provider-context';
import { loadedIds, type PagedState } from '../paged-list';
import { failedFirstPage, focusedIndex, wantedPages, type ShownRows } from '../paged-view';
import { ALERT, BUTTON, MUTED, SELECT } from '../ui';

/** The statuses of the status filter. */
const STATUSES = Object.keys(JOB_STATUS_LABELS) as JobStatus[];
/** The start of a fresh table. */
const TOP: ViewRestore = { scrollOffset: 0, index: null, focus: false };
/** The rows shown while the first page loads. */
const SKELETON_ROWS = 6;

/** A listed provider entry. */
type ProviderEntry = ProviderList['providers'][number];

/** The paged list of jobs. */
type PagedJobs = ReturnType<typeof usePagedList<JobView>>;
/** The filter of `jobs:list` without paging. */
type ListRequest = { status?: JobStatus; providerId?: string };

/** The newest list state the change listener reads. */
interface LatestList {
  paged: PagedJobs;
  key: string;
  listRequest: ListRequest;
}

/**
 * Background changes reach the table in place: changed jobs are read again and patched, jobs added,
 * removed or changed in bulk (or a reset) refresh the loaded pages.
 *
 * @param latest the newest list state
 * @param changes the changes
 */
function applyChanges(latest: MutableRefObject<LatestList>, changes: Changes): void {
  const { paged: current, key: startedKey, listRequest: request } = latest.current;
  if (changes.reset || changes.jobs) {
    current.refresh();
    return;
  }
  const ids = loadedIds(current.state, changes.jobIds);
  if (ids.length === 0) return;
  if (ids.length > MAX_CHOSEN_IDS) {
    current.refresh();
    return;
  }
  // No check beyond the key: a workspace read runs synchronously when the main process receives it, and IPC
  // answers arrive in the order asked, so a page requested after this read never answers before it.
  call('jobs:list', { ...request, ids, offset: 0, limit: ids.length }).then(
    (page) => {
      // Started for another list: its rows must not reach this one. The current list may have been read
      // before the change, so it is read again (queued while its first page is still loading).
      if (latest.current.key !== startedKey) {
        latest.current.paged.refresh();
        return;
      }
      if (page.items.length > 0) latest.current.paged.patch(page.items);
    },
    // The change must not be lost: the loaded pages are read again instead.
    () => latest.current.paged.refresh(),
  );
}

/** What a screen action works with. */
interface ActionRun {
  busyRef: MutableRefObject<boolean>;
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
  /** Makes the jobs context poll at once. */
  refresh(): void;
  /** Reloads the list. */
  reload(): void;
}

/**
 * Runs one action of the screen; afterwards the jobs poll at once and the list is reloaded.
 *
 * @param run the context
 * @param action the action
 * @returns resolves once done; never rejects; nothing runs while another action does
 */
async function runAction(run: ActionRun, action: () => Promise<unknown>): Promise<void> {
  // One action at a time; the ref also catches a second click before the busy render.
  if (run.busyRef.current) return;
  run.busyRef.current = true;
  run.setBusy(true);
  run.setError(null);
  try {
    await action();
  } catch (error) {
    run.setError(describeError(error));
  } finally {
    run.busyRef.current = false;
    run.setBusy(false);
    run.refresh();
    run.reload();
  }
}

/**
 * The provider filter: the chosen entry while it is listed, else all.
 *
 * @param entries the listed entries
 * @returns the chosen entry ('' for all) and its setter
 */
function useProviderFilter(entries: readonly ProviderEntry[]): [string, (value: string) => void] {
  // The chosen provider filter; '' (all) once its entry is no longer listed.
  const [chosenProvider, setChosenProvider] = useState('');
  const providerId = entries.some((entry) => entry.id === chosenProvider) ? chosenProvider : '';
  return [providerId, setChosenProvider];
}

/**
 * The jobs of the workspace, newest first, with a status filter, row and page actions.
 *
 * @returns the screen
 */
export function JobsScreen() {
  const { summary, active, refresh } = useJobs();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const providers = useProviders();
  const entries = providers.list?.providers ?? [];
  const [providerId, setChosenProvider] = useProviderFilter(entries);
  const [moving, setMoving] = useState(false);
  // Bumped after every action of this screen; it reloads the list. Background changes follow the
  // change feed in place instead.
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([status, providerId, reloadToken]);

  const containerRef = useRef<HTMLDivElement>(null);
  // Where the next mounted table starts; read once by each table when it mounts.
  const restore = useRef<ViewRestore>(TOP);
  const position = useRef<ViewHandle | null>(null);
  const [rows, setRows] = useState<ShownRows | null>(null);

  // The list's filter without paging; also the base of a read of chosen ids.
  const listRequest: ListRequest = {
    ...(status === '' ? {} : { status }),
    ...(providerId === '' ? {} : { providerId }),
  };
  const fetchPage = useCallback(
    (offset: number, limit: number) => call('jobs:list', { limit, offset, ...listRequest }),
    // `status` and `providerId` are all `listRequest` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, providerId],
  );

  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<JobView>(key, fetchPage, wanted);
  const total = paged.state.total;
  // Keyed by the displayed list: while a reload is pending, the old table stays where it was.
  const viewKey = paged.state.key;

  const latest = useRef<LatestList>({ paged, key, listRequest });
  latest.current = { paged, key, listRequest };
  useChanges((changes) => applyChanges(latest, changes));

  // A reload keeps the position and the focused row: the table remounts with the new list.
  const lastReload = useRef(reloadToken);
  if (lastReload.current !== reloadToken) {
    lastReload.current = reloadToken;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    const focused = focusedIndex(containerRef.current);
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: focused, focus: focused !== null };
  }

  const nextWanted = wantedPages(total, rows, viewKey);
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
    setStatus(STATUSES.find((listed) => listed === value) ?? '');
  }

  function chooseProvider(value: string) {
    restore.current = TOP;
    setChosenProvider(value);
  }

  const reload = () => setReloadToken((token) => token + 1);
  const run = (action: () => Promise<unknown>) => runAction({ busyRef, setBusy, setError, refresh, reload }, action);

  const finished = summary === null ? 0 : summary.succeeded + summary.failed + summary.cancelled;
  const retryable = summary === null ? 0 : summary.failed + summary.cancelled;
  const actions = (
    <JobsActions
      busy={busy}
      cancellable={summary !== null && active !== 0}
      retryable={retryable}
      finished={finished}
      onMove={() => setMoving(true)}
      run={run}
    />
  );
  const toolbar = (
    <JobsToolbar
      total={total}
      status={status}
      providerId={providerId}
      entries={entries}
      onStatus={chooseStatus}
      onProvider={chooseProvider}
    />
  );
  const table = {
    viewKey,
    paged: paged.state,
    restore: restore.current,
    onRows,
    onRetry: paged.retry,
    positionRef: position,
    onCancel: (job: JobView) => void run(() => call('jobs:cancel', { jobId: job.id })),
    onRetryJob: (job: JobView) => void run(() => call('jobs:retry', { jobId: job.id })),
  };

  return (
    <Page
      title={JOBS_TITLE}
      count={summary === null ? null : workspaceTotal(summary)}
      countTitle={JOBS_COUNT_TITLE}
      actions={actions}
      toolbar={toolbar}
    >
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3" aria-busy={paged.pending || undefined}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {jobsBody(paged.state, table)}
      </div>
      {moving && (
        <MoveJobsDialog
          source={undefined}
          onClose={() => {
            setMoving(false);
            reload();
          }}
        />
      )}
    </Page>
  );
}

/**
 * The body of the screen: Retry when the first page failed, skeleton rows while it loads, a line for
 * an empty list, else the table. A plain function, so every branch keeps its element as before.
 *
 * @param state the paged list
 * @param table the table props without the total
 * @returns the body
 */
function jobsBody(state: PagedState<JobView>, table: Omit<JobTableProps, 'total'>) {
  const total = state.total;
  const failedPage = failedFirstPage(state);
  if (failedPage !== null) {
    return (
      <div>
        <button type="button" className={BUTTON} onClick={() => table.onRetry(failedPage)}>
          {RETRY_LABEL}
        </button>
      </div>
    );
  }
  if (total === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} data-skeleton="" className="h-10 animate-pulse rounded-control bg-raised" />
        ))}
      </div>
    );
  }
  if (total === 0) return <p className={MUTED}>{NO_JOBS}</p>;
  return <JobTable key={table.viewKey} {...table} total={total} />;
}

/** The props of {@link JobsActions}. */
interface JobsActionsProps {
  busy: boolean;
  /** Some job is active. */
  cancellable: boolean;
  /** The failed and cancelled jobs. */
  retryable: number;
  /** The finished jobs. */
  finished: number;
  onMove(): void;
  run(action: () => Promise<unknown>): Promise<void>;
}

/**
 * The page actions: Move jobs, Cancel all, Retry failed, Clear finished.
 *
 * @param props the counts and the callbacks
 * @returns the buttons
 */
function JobsActions({ busy, cancellable, retryable, finished, onMove, run }: JobsActionsProps) {
  const start = useFocusReturn(busy, run);
  return (
    <>
      <button type="button" className={BUTTON} title={MOVE_JOBS_TITLE} onClick={onMove}>
        {MOVE_JOBS_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || !cancellable}
        onClick={(event) => start(event.currentTarget, () => call('jobs:cancelAll', {}))}
      >
        {CANCEL_ALL_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || retryable === 0}
        onClick={(event) => start(event.currentTarget, () => call('jobs:retryFailed', {}))}
      >
        {RETRY_FAILED_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy || finished === 0}
        onClick={(event) => start(event.currentTarget, () => call('jobs:clearFinished', {}))}
      >
        {CLEAR_FINISHED_LABEL}
      </button>
    </>
  );
}

/**
 * A page button is disabled while its action runs, so the focus falls to the body: once the actions
 * are free again it goes back to the button that started the action, when that is still enabled and
 * nothing else took the focus meanwhile.
 *
 * @param busy whether an action runs
 * @param run runs one action
 * @returns starts an action from a button
 */
function useFocusReturn(
  busy: boolean,
  run: (action: () => Promise<unknown>) => Promise<void>,
): (button: HTMLButtonElement, action: () => Promise<unknown>) => void {
  const returnTo = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (busy) return;
    const button = returnTo.current;
    returnTo.current = null;
    if (button === null || !button.isConnected || button.disabled) return;
    const active = document.activeElement;
    if (active === null || active === document.body) button.focus();
  }, [busy]);
  return (button, action) => {
    returnTo.current = button;
    void run(action);
  };
}

/**
 * Every job of the workspace, whatever the filters: the count beside the title says so in its tooltip.
 *
 * @param summary the polled summary
 * @returns the number of jobs in all statuses
 */
function workspaceTotal(summary: JobSummary): number {
  return summary.queued + summary.running + summary.waiting + summary.failed + summary.cancelled + summary.succeeded;
}

/** The props of {@link JobsToolbar}. */
interface JobsToolbarProps {
  /** The number of jobs the filters match; null while unknown. */
  total: number | null;
  status: JobStatus | '';
  providerId: string;
  entries: readonly ProviderEntry[];
  onStatus(value: string): void;
  onProvider(value: string): void;
}

/**
 * The filters: status and provider, and the number of jobs they match.
 *
 * @param props the matched count, the filter values, the entries and the callbacks
 * @returns the filter bar
 */
function JobsToolbar({ total, status, providerId, entries, onStatus, onProvider }: JobsToolbarProps) {
  return (
    <FilterBar resultCount={total === null ? null : jobCount(total)} onClear={null}>
      <select
        className={SELECT}
        aria-label={JOBS_STATUS_LABEL}
        value={status}
        onChange={(event) => onStatus(event.target.value)}
      >
        <option value="">{ALL_STATUSES}</option>
        {STATUSES.map((listed) => (
          <option key={listed} value={listed}>
            {jobStatusLabel(listed)}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        aria-label={JOBS_PROVIDER_HEADER}
        value={providerId}
        onChange={(event) => onProvider(event.target.value)}
      >
        <option value="">{ALL_PROVIDERS}</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </FilterBar>
  );
}
