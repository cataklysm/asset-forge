import { CheckCircle2, CircleAlert, Download, FileImage, LoaderCircle, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SiteCrawlTask } from '@assetforge/contracts';
import { shortUrl } from '../format';
import { SITE_EDIT_PROFILE_LABEL, SITE_IMPORT_SELECTED_LABEL, SITE_SKIP_NAMES_LABEL } from '../labels';
import { BORDER, BUTTON, FOCUS, MUTED } from '../ui';
import { CrawlResultView } from './SiteCrawlPanel';
import { ExtractionProgress, ExtractionStatus } from './ExtractionStatus';
import { crawlTargetLabel, extractionTitle, processedDownloads } from './extraction-presentation';

/** The primary action uses the existing accent token; secondary actions stay visually quiet. */
export const EXTRACTION_PRIMARY = `inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-3.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${FOCUS}`;
/** A low-emphasis action that does not compete with the next workflow step. */
export const EXTRACTION_SECONDARY = `inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-2 text-xs text-muted hover:bg-raised hover:text-text disabled:opacity-40 ${FOCUS}`;

/** Selection is owned by the shared review logic; this component only presents the navigation-page view. */
interface Props {
  task: SiteCrawlTask;
  busy: boolean;
  selected: Set<string>;
  skipExistingNames: boolean;
  page: number;
  pageSize: number;
  reviewable: boolean;
  onToggle(url: string, checked: boolean): void;
  onSkipNames(checked: boolean): void;
  onSelectAll(): void;
  onClearSelection(): void;
  onPage(page: number): void;
  onImport(): void;
  onEditProfile(): void;
  onClear(): void;
  onLogIn(): void;
  onRetry(): void;
  onOpenJobs?(): void;
}

/**
 * Gives importing and completed tasks a clear outcome and next action instead of leaving the result form on screen.
 * @param props saved task, action lock and cleanup/review callbacks
 * @returns import progress, outcome counters and relevant actions
 */
function ImportOutcome({
  task,
  busy,
  onClear,
  onReview,
  onOpenJobs,
}: {
  task: SiteCrawlTask;
  busy: boolean;
  onClear(): void;
  onReview(): void;
  onOpenJobs?(): void;
}) {
  const downloads = task.downloads;
  const completed = task.status === 'completed';
  const failed = task.status === 'import_failed';
  const legacy = downloads == null;
  const Icon = completed ? CheckCircle2 : failed ? CircleAlert : LoaderCircle;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-2xl ${failed ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'}`}
        >
          <Icon size={24} aria-hidden className={!completed && !failed && !legacy ? 'animate-spin' : undefined} />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-semibold">
            {completed
              ? 'Import complete'
              : failed
                ? 'Some downloads need attention'
                : legacy
                  ? 'Import submitted'
                  : 'Import in progress'}
          </h3>
          <p className={`text-sm leading-relaxed ${MUTED}`}>
            {completed
              ? 'All downloads have finished. Clear this entry when you are done.'
              : failed
                ? 'Review failed or cancelled downloads in Jobs. Successful files are already available.'
                : legacy
                  ? 'Detailed progress is unavailable for this older import. Its downloads remain available in Jobs.'
                  : 'Downloads continue in the background. You can keep working.'}
          </p>
        </div>
        {downloads != null && (
          <div className={`space-y-4 rounded-tile border bg-surface/50 p-4 ${BORDER}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {processedDownloads(task)} <span className={`text-base font-normal ${MUTED}`}>/ {downloads.total}</span>
              </span>
              <span className={`text-xs ${MUTED}`}>files processed</span>
            </div>
            <ExtractionProgress task={task} />
            {!completed && (
              <dl className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <dt className={MUTED}>Completed</dt>
                  <dd className="mt-1 text-base tabular-nums">{downloads.succeeded}</dd>
                </div>
                <div>
                  <dt className={MUTED}>Active</dt>
                  <dd className="mt-1 text-base tabular-nums">{downloads.running}</dd>
                </div>
                <div>
                  <dt className={MUTED}>Queued</dt>
                  <dd className="mt-1 text-base tabular-nums">{downloads.queued + downloads.waiting}</dd>
                </div>
                <div>
                  <dt className={MUTED}>Issues</dt>
                  <dd className={`mt-1 text-base tabular-nums ${failed ? 'text-danger' : ''}`}>
                    {downloads.failed + downloads.cancelled}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {onOpenJobs !== undefined && !completed && (
            <button type="button" className={failed ? EXTRACTION_PRIMARY : EXTRACTION_SECONDARY} onClick={onOpenJobs}>
              Open Jobs
            </button>
          )}
          {(completed || failed || legacy) && (
            <button
              type="button"
              className={failed ? EXTRACTION_SECONDARY : EXTRACTION_PRIMARY}
              disabled={busy}
              onClick={onClear}
              title="Clears this entry; keeps files and download jobs"
            >
              <Trash2 size={15} aria-hidden />
              Clear entry
            </button>
          )}
          <button type="button" className={EXTRACTION_SECONDARY} onClick={onReview}>
            Review extracted files
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A focused detail view with one primary action, compact metadata and a result list that owns its scroll area.
 * @param props persisted task and shared review selection
 * @returns the selected task's current workflow phase
 */
export function ExtractionDetail(props: Props) {
  const { task, busy, selected, skipExistingNames, page, pageSize, reviewable } = props;
  const imported = ['imported', 'completed', 'import_failed'].includes(task.status);
  const [showFiles, setShowFiles] = useState(!imported);
  useEffect(() => {
    setShowFiles(!imported);
  }, [imported]);
  const rows = task.candidates.slice(page * pageSize, (page + 1) * pageSize);
  const retryable = ['failed', 'cancelled', 'waiting'].includes(task.status);
  return (
    <section aria-label="Extraction details" className="flex h-full min-h-0 min-w-0 flex-col gap-5">
      <header className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-semibold capitalize" title={task.galleryUrl}>
              {extractionTitle(task)}
            </h2>
            <p className={`mt-1 truncate text-xs ${MUTED}`} title={task.galleryUrl}>
              {shortUrl(task.galleryUrl)}
            </p>
          </div>
          <ExtractionStatus task={task} />
        </div>
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${MUTED}`}>
          <span>Target: {crawlTargetLabel(task)}</span>
          <span aria-hidden>·</span>
          <span>
            {task.progress.files} files · {task.progress.pages} pages
          </span>
          <button
            type="button"
            className={`ml-auto ${EXTRACTION_SECONDARY}`}
            disabled={busy}
            onClick={props.onEditProfile}
          >
            <Settings2 size={13} aria-hidden />
            {SITE_EDIT_PROFILE_LABEL}
          </button>
        </div>
      </header>
      {task.errorMessage !== null && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {task.errorMessage}
        </p>
      )}
      {retryable && (
        <div className="flex shrink-0 gap-2">
          <button type="button" className={BUTTON} disabled={busy} onClick={props.onLogIn}>
            Open site
          </button>
          <button type="button" className={BUTTON} disabled={busy} onClick={props.onRetry}>
            {task.status === 'waiting' ? 'Resume extraction' : 'Retry extraction'}
          </button>
        </div>
      )}
      {imported && !showFiles ? (
        <ImportOutcome
          task={task}
          busy={busy}
          onClear={props.onClear}
          onReview={() => setShowFiles(true)}
          onOpenJobs={props.onOpenJobs}
        />
      ) : (
        <>
          {reviewable && task.candidates.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {selected.size} of {task.candidates.length} selected
                </span>
                <button
                  type="button"
                  className={EXTRACTION_SECONDARY}
                  disabled={busy || !reviewable}
                  onClick={props.onSelectAll}
                  aria-label="Select all eligible files"
                >
                  Select all
                </button>
                <button
                  type="button"
                  className={EXTRACTION_SECONDARY}
                  disabled={busy || !reviewable}
                  onClick={props.onClearSelection}
                >
                  Clear selection
                </button>
              </div>
              <button
                type="button"
                className={EXTRACTION_PRIMARY}
                disabled={busy || !reviewable || selected.size === 0}
                onClick={props.onImport}
              >
                <Download size={15} aria-hidden />
                {SITE_IMPORT_SELECTED_LABEL}
              </button>
            </div>
          )}
          {reviewable && task.target !== null && task.candidates.length > 0 && (
            <label className={`flex shrink-0 items-center gap-2 text-xs ${MUTED}`} title={SITE_SKIP_NAMES_LABEL}>
              <input
                type="checkbox"
                className={`accent-accent ${FOCUS}`}
                aria-label={SITE_SKIP_NAMES_LABEL}
                checked={skipExistingNames}
                disabled={busy || !reviewable}
                onChange={(event) => props.onSkipNames(event.target.checked)}
              />
              Skip existing filenames
            </label>
          )}
          {rows.length > 0 ? (
            <div
              role="region"
              aria-label="Found files"
              tabIndex={0}
              className={`min-h-0 flex-1 overflow-auto overscroll-contain rounded-tile border ${BORDER} ${FOCUS}`}
            >
              <table className="w-full table-fixed text-left text-sm" aria-label="Found files">
                <thead className="sticky top-0 z-10 bg-surface text-xs text-muted">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <span className="sr-only">Import</span>
                    </th>
                    <th className="px-2 py-2.5 font-normal">File</th>
                    <th className="w-32 px-3 py-2.5 font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((candidate) => (
                    <tr
                      key={candidate.url}
                      className={`border-t border-line/50 hover:bg-surface/60 ${candidate.alreadyPresent && !selected.has(candidate.url) ? 'text-muted' : ''}`}
                    >
                      <td className="px-3 py-3 align-top">
                        <input
                          type="checkbox"
                          className={`accent-accent ${FOCUS}`}
                          aria-label={`Select ${candidate.expectedName ?? candidate.url}`}
                          checked={selected.has(candidate.url)}
                          disabled={busy || !reviewable}
                          onChange={(event) => props.onToggle(candidate.url, event.target.checked)}
                        />
                      </td>
                      <td className="min-w-0 px-2 py-2.5">
                        <p className="flex min-w-0 items-center gap-2" title={candidate.url}>
                          <FileImage size={15} aria-hidden className="shrink-0 text-muted" />
                          <span className="truncate">{candidate.expectedName ?? shortUrl(candidate.url)}</span>
                        </p>
                        <p className={`ml-[23px] mt-1 truncate text-[11px] ${MUTED}`} title={candidate.sourcePageUrl}>
                          {shortUrl(candidate.sourcePageUrl)}
                        </p>
                      </td>
                      <td className="px-3 py-3 align-top text-[11px]">
                        <span
                          className={`inline-block rounded-full px-2 py-1 ${candidate.alreadyPresent ? 'bg-raised text-muted' : 'bg-accent-soft text-accent'}`}
                        >
                          {candidate.alreadyPresent
                            ? 'Existing file'
                            : candidate.expectedName === null
                              ? 'Name on download'
                              : 'New file'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center ${MUTED}`}>
              <LoaderCircle
                size={28}
                aria-hidden
                className={task.status === 'running' ? 'animate-spin text-accent' : ''}
              />
              <p className="text-sm">
                {['running', 'queued', 'waiting'].includes(task.status)
                  ? 'Collecting file links'
                  : 'No files to review'}
              </p>
              <p className="text-xs" role="status">
                {task.progress.pages} pages, {task.progress.files} files
              </p>
            </div>
          )}
          <footer className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted">
            {task.candidates.length > pageSize && (
              <>
                <button
                  type="button"
                  className={EXTRACTION_SECONDARY}
                  disabled={page === 0}
                  onClick={() => props.onPage(page - 1)}
                >
                  Previous files
                </button>
                <span className="tabular-nums">
                  {page * pageSize + 1}–{Math.min((page + 1) * pageSize, task.candidates.length)} of{' '}
                  {task.candidates.length}
                </span>
                <button
                  type="button"
                  className={EXTRACTION_SECONDARY}
                  disabled={(page + 1) * pageSize >= task.candidates.length}
                  onClick={() => props.onPage(page + 1)}
                >
                  Next files
                </button>
              </>
            )}
            {imported && (
              <button type="button" className={`ml-auto ${EXTRACTION_SECONDARY}`} onClick={() => setShowFiles(false)}>
                Back to import progress
              </button>
            )}
            {task.result !== null && (
              <details className="relative ml-auto">
                <summary className={`cursor-pointer rounded-control px-2 py-1 ${FOCUS}`}>
                  Extraction diagnostics
                </summary>
                <div
                  className={`absolute bottom-full right-0 z-20 mb-2 max-h-56 w-72 overflow-auto rounded-tile border bg-surface p-3 shadow-lg ${BORDER}`}
                >
                  <CrawlResultView result={task.result} showFiles={false} />
                </div>
              </details>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
