import { useEffect, useRef, useState } from 'react';
import type { SiteCrawlTask } from '@assetforge/contracts';
import { formatDateTime, shortUrl } from '../format';
import {
  CRAWL_CANCEL_LABEL,
  FOUND_FILES_LABEL,
  OPEN_SITE_LABEL,
  SITE_AVAILABLE_LABEL,
  SITE_CLEAR_SELECTION_LABEL,
  SITE_IMPORT_SELECTED_LABEL,
  SITE_INBOX_TARGET_LABEL,
  SITE_PRESENT_LABEL,
  SITE_RESUME_LABEL,
  SITE_RETRY_LABEL,
  SITE_SELECT_ALL_LABEL,
  SITE_SKIP_NAMES_LABEL,
  SITE_TASK_STATUS,
  SITE_UNKNOWN_NAME_LABEL,
  crawlProgressText,
} from '../labels';
import { ALERT, BORDER, BUTTON, FOCUS, MUTED, PANEL_TITLE } from '../ui';
import { CrawlResultView } from './SiteCrawlPanel';

/** Candidate rows rendered at once; selection spans the complete saved result. */
const CANDIDATE_PAGE_SIZE = 50;

/** Reviewed choices; existing names need a separate intentional override. */
export interface SiteImportSelection {
  selectedUrls: string[];
  skipExistingNames: boolean;
  includeExistingUrls: string[];
}

/**
 * Human-readable captured destination of a task, independent of the current navigation context.
 *
 * @param task its saved destination
 * @returns the destination label
 */
export function crawlTargetLabel(task: Pick<SiteCrawlTask, 'target' | 'targetAssetName'>): string {
  return task.target === null ? SITE_INBOX_TARGET_LABEL : `${task.targetAssetName ?? 'Asset'} · ${task.target.role}`;
}

/**
 * Selects eligible candidates according to the current filename rule.
 *
 * @param task raw saved candidates with live filename matches
 * @param skipExistingNames whether known names should start unselected
 * @returns selected URLs
 */
function eligibleUrls(task: SiteCrawlTask, skipExistingNames: boolean): Set<string> {
  return new Set(
    task.candidates
      .filter((candidate) => !skipExistingNames || !candidate.alreadyPresent)
      .map((candidate) => candidate.url),
  );
}

/** Review controls and actions for one captured extraction. */
interface Props {
  task: SiteCrawlTask;
  busy: boolean;
  onImport(selection: SiteImportSelection): void;
  onCancel(): void;
  onLogIn(): void;
  onRetry(): void;
}

/**
 * A saved extraction's progress, diagnostics and paged selectable candidates.
 *
 * @param props the captured task and explicit actions
 * @returns its review panel
 */
export function SiteCrawlReview({ task, busy, onImport, onCancel, onLogIn, onRetry }: Props) {
  const [skipExistingNames, setSkipExistingNames] = useState(task.target !== null);
  const [selected, setSelected] = useState(() => eligibleUrls(task, task.target !== null));
  const [page, setPage] = useState(0);
  const selectionKey = JSON.stringify([
    task.crawlId,
    skipExistingNames,
    task.candidates.map((candidate) => [candidate.url, candidate.alreadyPresent]),
  ]);
  const selectionRevision = useRef(selectionKey);
  useEffect(() => {
    if (selectionRevision.current === selectionKey) return;
    selectionRevision.current = selectionKey;
    setSelected(eligibleUrls(task, skipExistingNames));
    setPage(0);
  }, [task, skipExistingNames, selectionKey]);
  const active = task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
  const reviewable = task.result !== null && ['ready', 'cancelled', 'imported'].includes(task.status);
  const retryable = task.status === 'failed' || task.status === 'cancelled' || task.status === 'waiting';
  const first = page * CANDIDATE_PAGE_SIZE;
  const rows = task.candidates.slice(first, first + CANDIDATE_PAGE_SIZE);
  const toggle = (url: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(url);
      else next.delete(url);
      return next;
    });
  };
  return (
    <section aria-label="Extraction details" className="flex min-w-0 flex-col gap-3">
      <div className={`flex flex-col gap-1 rounded-control border p-3 ${BORDER}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={PANEL_TITLE}>{task.profileName}</h3>
          <span className={`text-sm ${MUTED}`}>{SITE_TASK_STATUS[task.status]}</span>
        </div>
        <p className="break-all text-sm" title={task.galleryUrl}>
          {shortUrl(task.galleryUrl)}
        </p>
        <p className={`text-sm ${MUTED}`}>Target: {crawlTargetLabel(task)}</p>
        <p className={`text-xs ${MUTED}`}>{formatDateTime(task.createdAt)}</p>
        <p className="text-sm tabular-nums" role="status">
          {crawlProgressText(task.progress.pages, task.progress.files)}
        </p>
      </div>
      {task.errorMessage !== null && (
        <p className={ALERT} role="alert">
          {task.errorMessage}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {active && (
          <button type="button" className={BUTTON} disabled={busy || task.progress.cancelling} onClick={onCancel}>
            {CRAWL_CANCEL_LABEL}
          </button>
        )}
        {retryable && (
          <>
            <button type="button" className={BUTTON} disabled={busy} onClick={onLogIn}>
              {OPEN_SITE_LABEL}
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={onRetry}>
              {task.status === 'waiting' ? SITE_RESUME_LABEL : SITE_RETRY_LABEL}
            </button>
          </>
        )}
      </div>
      {task.result !== null && <CrawlResultView result={task.result} showFiles={false} />}
      {task.candidates.length > 0 && (
        <>
          {task.target !== null && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={`accent-accent ${FOCUS}`}
                checked={skipExistingNames}
                disabled={busy || !reviewable}
                onChange={(event) => setSkipExistingNames(event.target.checked)}
              />
              {SITE_SKIP_NAMES_LABEL}
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className={`mr-auto text-sm tabular-nums ${MUTED}`}>
              {selected.size} of {task.candidates.length} selected
            </span>
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !reviewable}
              onClick={() => setSelected(eligibleUrls(task, skipExistingNames))}
            >
              {SITE_SELECT_ALL_LABEL}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !reviewable}
              onClick={() => setSelected(new Set())}
            >
              {SITE_CLEAR_SELECTION_LABEL}
            </button>
          </div>
          <div
            role="region"
            aria-label={FOUND_FILES_LABEL}
            tabIndex={0}
            className={`max-h-[min(40dvh,20rem)] overflow-auto overscroll-contain rounded-control border ${BORDER} ${FOCUS}`}
          >
            <table className="w-full text-left text-sm" aria-label={FOUND_FILES_LABEL}>
              <thead className={`sticky top-0 z-10 border-b bg-surface ${BORDER}`}>
                <tr>
                  <th className="p-2">Import</th>
                  <th className="p-2">File / source page</th>
                  <th className="p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((candidate) => (
                  <tr key={candidate.url} className={`border-b last:border-b-0 ${BORDER}`}>
                    <td className="p-2 align-top">
                      <input
                        type="checkbox"
                        className={`accent-accent ${FOCUS}`}
                        aria-label={`Select ${candidate.expectedName ?? candidate.url}`}
                        checked={selected.has(candidate.url)}
                        disabled={busy || !reviewable}
                        onChange={(event) => toggle(candidate.url, event.target.checked)}
                      />
                    </td>
                    <td className="min-w-0 p-2">
                      <p className="break-all" title={candidate.url}>
                        {candidate.expectedName ?? shortUrl(candidate.url)}
                      </p>
                      <p className={`break-all text-xs ${MUTED}`} title={candidate.sourcePageUrl}>
                        {shortUrl(candidate.sourcePageUrl)}
                      </p>
                    </td>
                    <td className={`p-2 align-top text-xs ${MUTED}`}>
                      {candidate.alreadyPresent
                        ? SITE_PRESENT_LABEL
                        : candidate.expectedName === null
                          ? SITE_UNKNOWN_NAME_LABEL
                          : SITE_AVAILABLE_LABEL}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {task.candidates.length > CANDIDATE_PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={BUTTON}
                disabled={page === 0}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous files
              </button>
              <span className={`text-sm tabular-nums ${MUTED}`}>
                {first + 1}–{Math.min(first + CANDIDATE_PAGE_SIZE, task.candidates.length)} of {task.candidates.length}
              </span>
              <button
                type="button"
                className={BUTTON}
                disabled={first + CANDIDATE_PAGE_SIZE >= task.candidates.length}
                onClick={() => setPage((current) => current + 1)}
              >
                Next files
              </button>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !reviewable || selected.size === 0}
              onClick={() =>
                onImport({
                  selectedUrls: [...selected],
                  skipExistingNames,
                  includeExistingUrls: task.candidates
                    .filter((candidate) => candidate.alreadyPresent && selected.has(candidate.url))
                    .map((candidate) => candidate.url),
                })
              }
            >
              {SITE_IMPORT_SELECTED_LABEL}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
