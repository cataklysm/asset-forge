import { RotateCcw, X } from 'lucide-react';
import { useRef, type RefObject } from 'react';
import {
  ACTIVE_JOB_STATUSES,
  ANALYZE_FILE_JOB,
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  MAX_ATTEMPTS,
  type JobStatus,
  type JobView,
  type ProviderList,
} from '@assetforge/contracts';
import { formatDateTime, shortUrl } from '../format';
import { rowCount } from '../gallery';
import {
  useElementSize,
  useVirtualRows,
  type ViewHandle,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import {
  CANCEL_JOB_LABEL,
  JOB_RESULT_LABELS,
  JOB_TYPE_LABELS,
  JOBS_ACTIONS_HEADER,
  JOBS_ATTEMPT_HEADER,
  JOBS_CREATED_HEADER,
  JOBS_ERROR_HEADER,
  JOBS_FILE_HEADER,
  JOBS_PROVIDER_HEADER,
  JOBS_STATUS_HEADER,
  JOBS_TITLE,
  JOBS_TYPE_HEADER,
  jobStatusLabel,
  nextTryTitle,
  RETRY_JOB_LABEL,
  RETRY_LABEL,
} from '../labels';
import { useProviders } from '../provider-context';
import { retryIndex, slotAt, type PagedState, type Slot } from '../paged-list';
import { BORDER, BUTTON_INLINE, ICON_BUTTON, ITEM_HOVER, MUTED } from '../ui';
import { laneName } from './MoveJobsDialog';

/** The statuses a job can be cancelled in. */
const CANCELLABLE: ReadonlySet<JobStatus> = new Set(ACTIVE_JOB_STATUSES);
/** The statuses a job can be retried in. */
const RETRYABLE: ReadonlySet<JobStatus> = new Set(['failed', 'cancelled']);

/** The height of the header row in pixels. */
const HEADER_HEIGHT = 32;
/** The height of a job row in pixels. */
const ROW_HEIGHT = 48;
/** The focus ring of a row, drawn inside it. */
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
/** The columns of the header and every row. */
const COLUMNS =
  'grid grid-cols-[9rem_minmax(8rem,1.2fr)_minmax(8rem,1fr)_6rem_5rem_10rem_minmax(8rem,1.5fr)_2.5rem] items-center gap-3 px-2';
/** The column headers before the actions column. */
const HEADERS = [
  JOBS_TYPE_HEADER,
  JOBS_FILE_HEADER,
  JOBS_PROVIDER_HEADER,
  JOBS_STATUS_HEADER,
  JOBS_ATTEMPT_HEADER,
  JOBS_CREATED_HEADER,
  JOBS_ERROR_HEADER,
];

/**
 * The label of a job type.
 *
 * @param type the job type
 * @returns its label, or the type itself when it has none
 */
function jobLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}

/** The props of {@link JobTable}. */
export interface JobTableProps {
  viewKey: string;
  paged: PagedState<JobView>;
  total: number;
  /** Where the table starts; read once when it mounts. */
  restore: ViewRestore;
  onRows(rows: VisibleRows): void;
  /** Reads a failed page again. */
  onRetry(page: number): void;
  positionRef: { current: ViewHandle | null };
  onCancel(job: JobView): void;
  onRetryJob(job: JobView): void;
}

/**
 * The virtualised grid of jobs; its rows render once the scroll area has a height.
 *
 * @param props the list, the position and the callbacks
 * @returns the grid
 */
export function JobTable(props: JobTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={JOBS_TITLE}
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <JobRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

/** The props of {@link JobRows}. */
interface JobRowsProps extends JobTableProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The height of the scroll area in pixels. */
  height: number;
}

/**
 * The header row and the visible job rows.
 *
 * @param props the table props, the scroll area and its height
 * @returns the rows
 */
function JobRows(props: JobRowsProps) {
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
      <HeaderRow />
      {virtualizer.getVirtualItems().map((row) => {
        const index = row.index;
        const slot = slotAt(paged, index);
        const style = { top: row.start, height: ROW_HEIGHT };
        const tabbable = index === rows.tabbableIndex;
        if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
          const retry = () => {
            rows.refocus(index);
            onRetry(slot.page);
          };
          return retryRow({ index, style, tabbable, rows, onRetry: retry });
        }
        return jobRow({ index, slot, style, tabbable, rows, onCancel, onRetryJob });
      })}
    </div>
  );
}

/**
 * The sticky header row.
 *
 * @returns the row
 */
function HeaderRow() {
  return (
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
      <span role="columnheader" aria-label={JOBS_ACTIONS_HEADER} />
    </div>
  );
}

/** The keyboard and focus handlers of the virtual rows. */
type RowHandlers = Pick<ReturnType<typeof useVirtualRows>, 'onItemKeyDown' | 'onItemFocus'>;

/** What {@link retryRow} draws. */
interface RetryRowProps {
  index: number;
  style: { top: number; height: number };
  tabbable: boolean;
  rows: RowHandlers;
  onRetry(): void;
}

/**
 * The row in place of a page that failed to load, with Retry. A plain function, not a component: a
 * row that turns from a failed page into a job keeps its element.
 *
 * @param props the row index, its place and the retry callback
 * @returns the row, keyed by its index
 */
function retryRow({ index, style, tabbable, rows, onRetry }: RetryRowProps) {
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
          onClick={onRetry}
          onKeyDown={(event) => rows.onItemKeyDown(index, event)}
          onFocus={() => rows.onItemFocus(index)}
        >
          {RETRY_LABEL}
        </button>
      </span>
    </div>
  );
}

/** What {@link jobRow} draws. */
interface JobRowProps {
  index: number;
  slot: Slot<JobView>;
  style: { top: number; height: number };
  tabbable: boolean;
  rows: RowHandlers;
  onCancel(job: JobView): void;
  onRetryJob(job: JobView): void;
}

/**
 * A job row; empty and disabled while its job is not loaded. A plain function like {@link retryRow}.
 *
 * @param props the row index, its slot, its place and the callbacks
 * @returns the row, keyed by its index
 */
function jobRow({ index, slot, style, tabbable, rows, onCancel, onRetryJob }: JobRowProps) {
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
      onKeyDown={(event) => rows.onItemKeyDown(index, event)}
      onFocus={() => rows.onItemFocus(index)}
    >
      {job !== null && (
        <JobCells
          job={job}
          tabIndex={tabbable ? 0 : -1}
          onCancel={() => onCancel(job)}
          onRetry={() => onRetryJob(job)}
        />
      )}
    </div>
  );
}

/**
 * The provider of an analysis or generation job: the current entry name (or the stored one) and the
 * model when there is one (an upscale has none); the host of a download; '—' for other jobs.
 *
 * @param list the provider list; null while it is not loaded
 * @param job the job
 * @returns the text
 */
function providerText(list: ProviderList | null, job: JobView): string {
  if (job.type === FILE_DOWNLOAD_JOB) return job.host ?? '—';
  if (job.type !== ANALYZE_FILE_JOB && job.type !== IMAGE_GENERATE_JOB) return '—';
  const name = laneName(list, job.providerId, job.providerName);
  return job.model === null ? name : `${name} · ${job.model}`;
}

/** The props of {@link JobCells}. */
interface JobCellsProps {
  job: JobView;
  /** The tab index of the action buttons. */
  tabIndex: number;
  onCancel(): void;
  onRetry(): void;
}

/**
 * The cells of a loaded job row.
 *
 * @param props the job, the tab index and the callbacks
 * @returns the cells
 */
function JobCells({ job, tabIndex, onCancel, onRetry }: JobCellsProps) {
  const { list } = useProviders();
  const provider = providerText(list, job);
  // A download names its address until it has a file; the full address is in the tooltip.
  const fileText = job.fileName ?? (job.url === null ? '—' : shortUrl(job.url));
  const fileTitle = job.fileName ?? job.url ?? undefined;
  const statusText =
    job.status === 'succeeded' && job.result !== null ? JOB_RESULT_LABELS[job.result] : jobStatusLabel(job.status);
  const waitTitle =
    job.status === 'retry_wait' && job.runAfter !== null ? nextTryTitle(formatDateTime(job.runAfter)) : undefined;
  return (
    <>
      <span role="gridcell" className="truncate">
        {jobLabel(job.type)}
      </span>
      <span role="gridcell" className="truncate font-medium" title={fileTitle}>
        {fileText}
      </span>
      <span role="gridcell" className="truncate" title={provider}>
        {provider}
      </span>
      <span role="gridcell" className={`truncate ${job.status === 'failed' ? 'text-danger' : ''}`} title={waitTitle}>
        {statusText}
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
      <JobActions job={job} tabIndex={tabIndex} onCancel={onCancel} onRetry={onRetry} />
    </>
  );
}

/**
 * The actions cell: Cancel while the job is active, Retry once it failed or was cancelled.
 *
 * @param props the job, the tab index and the callbacks
 * @returns the cell
 */
function JobActions({ job, tabIndex, onCancel, onRetry }: JobCellsProps) {
  return (
    <span role="gridcell" className="flex justify-end">
      {CANCELLABLE.has(job.status) && (
        <button
          type="button"
          className={ICON_BUTTON}
          tabIndex={tabIndex}
          title={CANCEL_JOB_LABEL}
          aria-label={CANCEL_JOB_LABEL}
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
          title={RETRY_JOB_LABEL}
          aria-label={RETRY_JOB_LABEL}
          onClick={onRetry}
        >
          <RotateCcw size={16} aria-hidden />
        </button>
      )}
    </span>
  );
}
