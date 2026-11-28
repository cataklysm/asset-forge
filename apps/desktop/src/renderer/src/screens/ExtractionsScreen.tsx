import { Eraser, Plus, ScanSearch } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteCrawlTaskSummary, UrlImportResult } from '@assetforge/contracts';
import type { MenuItem } from '../components/Menu';
import { SiteCrawlReview, type SiteImportSelection } from '../components/SiteCrawlReview';
import {
  cancelExtraction,
  clearCompletedExtractions,
  importExtraction,
  openExtractionLogin,
  refreshExtractions,
  removeExtraction,
  restartExtraction,
  retryExtraction,
  type ExtractionPageActions,
} from '../components/extraction-page-actions';
import { SiteExtractionCard } from '../components/SiteExtractionCard';
import { EXTRACTION_PRIMARY, EXTRACTION_SECONDARY } from '../components/ExtractionDetail';
import { SiteImportDialog } from '../components/SiteImportDialog';
import { CRAWL_TASK_PAGE_SIZE, useCrawlTask, useCrawlTasks } from '../components/site-crawl-tasks';
import { runSiteAction, type SiteImportBusy } from '../components/site-import-actions';
import { useJobs } from '../jobs-context';
import {
  CRAWL_CANCEL_LABEL,
  SITE_EXTRACT_AGAIN_LABEL,
  SITE_REMOVE_EXTRACTION_LABEL,
  SITE_REMOVE_ACTIVE_TITLE,
  SITE_REVIEW_EMPTY,
  SITE_REVIEW_TEXT,
  SITE_TASKS_EMPTY,
  SITE_TASKS_LABEL,
  siteImportOutcomeText,
} from '../labels';
import { ALERT, BORDER, BUTTON, MUTED } from '../ui';

/**
 * The workspace's saved extractions, accessible independently of the asset and inbox screens.
 * New extractions target the inbox; saved tasks retain their captured destinations.
 *
 * @returns an independently scrolling card list and exactly one selected extraction's details
 */
export function ExtractionsScreen({ onOpenJobs }: { onOpenJobs?(): void } = {}) {
  const tasks = useCrawlTasks();
  const jobs = useJobs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const summary = tasks.items.find((task) => task.crawlId === selectedId);
  const selected = useCrawlTask(selectedId, summary === undefined ? undefined : JSON.stringify(summary), revision);
  const [configuration, setConfiguration] = useState<{ profileId?: string } | null>(null);
  const [busy, setBusy] = useState<SiteImportBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ crawlId: string; result: UrlImportResult } | null>(null);
  const selection = useRef<{ crawlId: string; value: SiteImportSelection } | null>(null);
  const acting = useRef(false);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const run = (kind: Exclude<SiteImportBusy, null>, action: () => Promise<void>) =>
    runSiteAction({ acting, disposed, setBusy, setError }, kind, action);
  const choose = (crawlId: string) => {
    if (crawlId !== selectedId) selection.current = null;
    setSelectedId(crawlId);
    setOutcome(null);
    setError(null);
    setNotice(null);
  };
  const captureSelection = useCallback(
    (value: SiteImportSelection) => {
      if (selectedId !== null) selection.current = { crawlId: selectedId, value };
    },
    [selectedId],
  );

  const actionState: ExtractionPageActions = {
    owner: { acting, disposed, setBusy, setError },
    tasks,
    selection,
    refreshJobs: jobs.refresh,
    refreshDetail: () => setRevision((current) => current + 1),
    choose,
    imported: (crawlId, result) => {
      setSelectedId(crawlId);
      setOutcome({ crawlId, result });
      if (result.invalid.length > 0) setNotice(`${result.invalid.length} addresses could not be queued.`);
      else if (result.queued + result.alreadyImported + result.alreadyQueued === 0)
        setNotice('No new files to import.');
    },
    removed: (crawlId) => {
      setSelectedId((current) => (current === crawlId ? null : current));
      if (selection.current?.crawlId === crawlId) selection.current = null;
      setOutcome((current) => (current?.crawlId === crawlId ? null : current));
    },
    cleared: (removed) => {
      const completedId = selected.task?.status === 'completed' ? selected.task.crawlId : null;
      if (removed > 0 && completedId !== null) {
        setSelectedId((current) => (current === completedId ? null : current));
        if (selection.current?.crawlId === completedId) selection.current = null;
      }
      setNotice(
        removed === 0
          ? 'No completed imports to clear.'
          : `Cleared ${removed} completed ${removed === 1 ? 'extraction' : 'extractions'}.`,
      );
    },
  };
  const refresh = () => refreshExtractions(actionState);
  const importTask = (crawlId: string, explicit?: SiteImportSelection) =>
    run('import', () => importExtraction(actionState, crawlId, explicit));
  const restart = (crawlId: string) => run('queue', () => restartExtraction(actionState, crawlId));
  const cancel = (crawlId: string) => run('cancel', () => cancelExtraction(actionState, crawlId));
  const remove = (crawlId: string) => run('remove', () => removeExtraction(actionState, crawlId));
  const itemsOf = (task: SiteCrawlTaskSummary): MenuItem[] => {
    const active = ['queued', 'running', 'waiting'].includes(task.status);
    return [
      {
        label: SITE_EXTRACT_AGAIN_LABEL,
        disabled: busy !== null || active,
        onSelect: () => void restart(task.crawlId),
      },
      {
        label: ['imported', 'completed', 'import_failed'].includes(task.status)
          ? 'Clear entry'
          : SITE_REMOVE_EXTRACTION_LABEL,
        disabled: busy !== null || active,
        title: active ? SITE_REMOVE_ACTIVE_TITLE : undefined,
        onSelect: () => void remove(task.crawlId),
      },
      ...(active
        ? [
            {
              label: CRAWL_CANCEL_LABEL,
              disabled: busy !== null || !active || task.progress.cancelling,
              onSelect: () => void cancel(task.crawlId),
            },
          ]
        : []),
      ...(task.status === 'ready'
        ? [
            {
              label: 'Import',
              disabled: busy !== null || task.progress.files === 0,
              onSelect: () => void importTask(task.crawlId),
            },
          ]
        : []),
    ];
  };
  const shownError = error ?? tasks.error ?? selected.error;
  const task = selected.task;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)]">
        <aside
          aria-label={SITE_TASKS_LABEL}
          className={`flex min-h-0 min-w-0 flex-col gap-3 border-r bg-surface/30 p-4 ${BORDER}`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2">
            <button type="button" className={EXTRACTION_PRIMARY} onClick={() => setConfiguration({})}>
              <Plus size={16} aria-hidden />
              New extraction
            </button>
            <span className={`text-xs tabular-nums ${MUTED}`}>{tasks.total}</span>
          </div>
          <button
            type="button"
            className={`self-start ${EXTRACTION_SECONDARY}`}
            title="Clears completed imports; keeps files and Jobs"
            disabled={busy !== null || tasks.total === 0}
            onClick={() => void run('remove', () => clearCompletedExtractions(actionState))}
          >
            <Eraser size={13} aria-hidden />
            Clear completed
          </button>
          <ul
            aria-label={SITE_TASKS_LABEL}
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-1"
          >
            {tasks.items.map((task) => (
              <SiteExtractionCard
                key={task.crawlId}
                task={task}
                selected={task.crawlId === selectedId}
                items={itemsOf(task)}
                onSelect={() => choose(task.crawlId)}
              />
            ))}
          </ul>
          {!tasks.loading && tasks.total === 0 && <p className={`text-sm ${MUTED}`}>{SITE_TASKS_EMPTY}</p>}
          {tasks.total > CRAWL_TASK_PAGE_SIZE && (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className={BUTTON}
                disabled={tasks.page === 0}
                onClick={() => tasks.setPage(tasks.page - 1)}
                aria-label={SITE_REVIEW_TEXT.previousTasks}
              >
                ←
              </button>
              <span className={`self-center text-sm ${MUTED}`}>
                {tasks.page + 1} / {Math.ceil(tasks.total / CRAWL_TASK_PAGE_SIZE)}
              </span>
              <button
                type="button"
                className={BUTTON}
                disabled={(tasks.page + 1) * CRAWL_TASK_PAGE_SIZE >= tasks.total}
                onClick={() => tasks.setPage(tasks.page + 1)}
                aria-label={SITE_REVIEW_TEXT.nextTasks}
              >
                →
              </button>
            </div>
          )}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col px-6 py-5">
          {task === null ? (
            <div className={`flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm ${MUTED}`}>
              <ScanSearch size={30} aria-hidden className="text-line-strong" />
              <p>{selectedId === null ? SITE_REVIEW_EMPTY : 'Loading extraction…'}</p>
            </div>
          ) : (
            <SiteCrawlReview
              key={task.crawlId}
              task={task}
              busy={busy !== null}
              actionsInMenu
              onSelectionChange={captureSelection}
              onImport={(choices) => void importTask(task.crawlId, choices)}
              onCancel={() => void cancel(task.crawlId)}
              onLogIn={() => void run('login', () => openExtractionLogin(task))}
              onRetry={() => void run('retry', () => retryExtraction(actionState, task.crawlId))}
              onRemove={() => void remove(task.crawlId)}
              onEditProfile={() => setConfiguration({ profileId: task.profileId })}
              onExtractAgain={() => void restart(task.crawlId)}
              canExtractAgain
              profileHasUnsavedChanges={false}
              onOpenJobs={onOpenJobs}
            />
          )}
          {outcome !== null && outcome.crawlId === selectedId && (
            <p role="status" className="sr-only">
              {siteImportOutcomeText(
                outcome.result.queued,
                outcome.result.alreadyImported,
                outcome.result.alreadyQueued,
                outcome.result.invalid.length,
              )}
            </p>
          )}
        </div>
      </div>
      {shownError !== null && (
        <p role="alert" className={`m-3 shrink-0 ${ALERT}`}>
          {shownError}
        </p>
      )}
      {configuration !== null && (
        <SiteImportDialog
          target={null}
          setupOnly
          initialProfileId={configuration.profileId}
          onClose={() => {
            setConfiguration(null);
            void refresh();
          }}
          onQueued={(crawlId) => {
            setConfiguration(null);
            choose(crawlId);
            tasks.setPage(0);
            void refresh();
          }}
        />
      )}
      {notice !== null && (
        <p role="status" className={`shrink-0 px-6 py-2 text-xs ${MUTED}`}>
          {notice}
        </p>
      )}
    </div>
  );
}
