import { useId } from 'react';
import type { FileTarget } from '@assetforge/contracts';
import { shortUrl } from '../format';
import {
  SITE_INBOX_TARGET_LABEL,
  SITE_QUEUE_LABEL,
  SITE_QUEUE_TITLE,
  SITE_REVIEW_TEXT,
  SITE_TASKS_EMPTY,
  SITE_TASKS_LABEL,
  SITE_TASK_STATUS,
  SITE_URLS_HINT,
  SITE_URLS_LABEL,
  crawlProgressText,
} from '../labels';
import { BORDER, BUTTON, LABEL, MUTED, PANEL_TITLE, TEXTAREA } from '../ui';
import { CRAWL_TASK_PAGE_SIZE, type CrawlTaskList } from './site-crawl-tasks';
import { crawlTargetLabel } from './SiteCrawlReview';

/** Submission controls for one or more galleries and a page of independently saved extraction tasks. */
interface Props {
  urls: string;
  target: FileTarget | null;
  locked: boolean;
  queueable: boolean;
  tasks: CrawlTaskList;
  selectedCrawlId: string | null;
  onUrlsChange(value: string): void;
  onQueue(): void;
  onSelect(crawlId: string): void;
}

/**
 * A batch URL composer and light task summaries; full candidates are loaded only for the selected task.
 *
 * @param props the submission values, saved task page and actions
 * @returns the extraction queue controls
 */
export function SiteExtractionQueue({
  urls,
  target,
  locked,
  queueable,
  tasks,
  selectedCrawlId,
  onUrlsChange,
  onQueue,
  onSelect,
}: Props) {
  const urlsId = useId();
  return (
    <>
      <section className={`flex flex-col gap-2 rounded-control border p-3 ${BORDER}`}>
        <label htmlFor={urlsId} className={LABEL}>
          {SITE_URLS_LABEL}
        </label>
        <textarea
          id={urlsId}
          className={`${TEXTAREA} min-h-24`}
          title={SITE_QUEUE_TITLE}
          value={urls}
          readOnly={locked}
          spellCheck={false}
          onChange={(event) => onUrlsChange(event.target.value)}
        />
        <p className={`text-xs ${MUTED}`}>{SITE_URLS_HINT}</p>
        <p className={`text-sm ${MUTED}`}>
          {SITE_REVIEW_TEXT.newExtractions}:{' '}
          {target === null ? SITE_INBOX_TARGET_LABEL : `${SITE_REVIEW_TEXT.currentAsset} · ${target.role}`}
        </p>
        <div>
          <button type="button" className={BUTTON} title={SITE_QUEUE_TITLE} disabled={!queueable} onClick={onQueue}>
            {SITE_QUEUE_LABEL}
          </button>
        </div>
      </section>
      <section aria-label={SITE_TASKS_LABEL} className="flex flex-col gap-2">
        <h3 className={PANEL_TITLE}>
          {SITE_TASKS_LABEL} <span className={MUTED}>({tasks.total})</span>
        </h3>
        {!tasks.loading && tasks.items.length === 0 && <p className={`text-sm ${MUTED}`}>{SITE_TASKS_EMPTY}</p>}
        <ul aria-label={SITE_TASKS_LABEL} className={`max-h-52 overflow-y-auto rounded-control border ${BORDER}`}>
          {tasks.items.map((task) => (
            <li key={task.crawlId} className={`border-b last:border-b-0 ${BORDER}`}>
              <button
                type="button"
                className={`${BUTTON} h-auto w-full flex-col items-start border-0 px-3 py-2 text-left`}
                aria-pressed={task.crawlId === selectedCrawlId}
                onClick={() => onSelect(task.crawlId)}
              >
                <span className="flex w-full flex-wrap justify-between gap-2">
                  <span>{task.profileName}</span>
                  <span className={`text-xs ${MUTED}`}>{SITE_TASK_STATUS[task.status]}</span>
                </span>
                <span className="max-w-full truncate text-xs" title={task.galleryUrl}>
                  {shortUrl(task.galleryUrl)}
                </span>
                <span className={`text-xs ${MUTED}`}>
                  {crawlTargetLabel(task)} · {crawlProgressText(task.progress.pages, task.progress.files)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {tasks.total > CRAWL_TASK_PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={tasks.page === 0}
              onClick={() => tasks.setPage(tasks.page - 1)}
            >
              {SITE_REVIEW_TEXT.previousTasks}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={(tasks.page + 1) * CRAWL_TASK_PAGE_SIZE >= tasks.total}
              onClick={() => tasks.setPage(tasks.page + 1)}
            >
              {SITE_REVIEW_TEXT.nextTasks}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
