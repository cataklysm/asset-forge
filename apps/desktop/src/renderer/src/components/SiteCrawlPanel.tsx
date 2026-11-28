import type { SiteCrawlResult } from '@assetforge/contracts';
import { shortUrl } from '../format';
import {
  CRAWL_CANCEL_LABEL,
  CRAWL_CANCEL_TITLE,
  CRAWL_CANCELLED_LABEL,
  CRAWL_PROBLEMS_LABEL,
  CRAWL_PROGRESS_LABEL,
  CRAWL_TRUNCATED_LABELS,
  crawlProgressText,
  FOUND_FILES_LABEL,
  GALLERY_URL_LABEL,
  GALLERY_URL_TITLE,
  moreProblemsText,
  SITE_CRAWL_COUNT_LABELS,
  SITE_TEST_LABEL,
  SITE_TEST_TITLE,
} from '../labels';
import { BORDER, BUTTON, MUTED } from '../ui';
import { noFilesHeadline, problemText, type CrawlProgressState } from './site-import-state';
import { Field } from './SiteProfileForm';

// The right half of the site import dialog: the gallery URL, the test with its progress, and the test's answer.

/** The counts shown only when they are above 0. */
const OPTIONAL_COUNTS = ['duplicates', 'filtered', 'disallowed', 'invalid', 'offSite', 'pageFailures'] as const;

/** The props of the crawl panel. */
interface Props {
  /** The gallery URL as typed. */
  url: string;
  /** Whether a test or a request runs, so that the URL cannot be changed. */
  locked: boolean;
  /** Receives the typed URL. */
  onUrlChange(value: string): void;
  /** Whether Test may start. */
  testable: boolean;
  /** Starts the test. */
  onTest(): void;
  /** Whether the test runs. */
  crawling: boolean;
  /** The running test's progress and its cancel. */
  progress: CrawlProgressState;
  /** The last test's answer; undefined when there is none. */
  result: SiteCrawlResult | undefined;
}

/**
 * The gallery URL, Test, the progress while it runs and the answer.
 *
 * @param props the URL, the test and its answer
 * @returns the panel's section
 */
export function SiteCrawlPanel({ url, locked, onUrlChange, testable, onTest, crawling, progress, result }: Props) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <Field label={GALLERY_URL_LABEL} title={GALLERY_URL_TITLE} value={url} readOnly={locked} onChange={onUrlChange} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} title={SITE_TEST_TITLE} disabled={!testable} onClick={onTest}>
          {SITE_TEST_LABEL}
        </button>
        {crawling && (
          <div className="flex items-center gap-2" role="status" aria-label={CRAWL_PROGRESS_LABEL}>
            {progress.progress !== null && (
              <span className={`text-sm tabular-nums ${MUTED}`}>
                {crawlProgressText(progress.progress.pages, progress.progress.files)}
              </span>
            )}
            <button
              type="button"
              className={BUTTON}
              title={CRAWL_CANCEL_TITLE}
              disabled={progress.cancelling}
              onClick={progress.cancel}
            >
              {CRAWL_CANCEL_LABEL}
            </button>
          </div>
        )}
      </div>
      {result !== undefined && <CrawlResultView result={result} />}
    </section>
  );
}

/**
 * The answer of a test: the counts, the headline when it found nothing, the problems and the found files.
 *
 * @param props the answer
 * @returns the answer's parts
 */
export function CrawlResultView({ result, showFiles = true }: { result: SiteCrawlResult; showFiles?: boolean }) {
  const headline = noFilesHeadline(result);
  return (
    <>
      <div className="flex flex-col gap-1 text-sm text-text">
        <p>{`${SITE_CRAWL_COUNT_LABELS.pages} ${result.pages}`}</p>
        <p>{`${SITE_CRAWL_COUNT_LABELS.files} ${result.files.length}`}</p>
        {OPTIONAL_COUNTS.map((key) =>
          result[key] > 0 ? <p key={key}>{`${SITE_CRAWL_COUNT_LABELS[key]} ${result[key]}`}</p> : null,
        )}
        {result.truncated !== null && <p>{CRAWL_TRUNCATED_LABELS[result.truncated]}</p>}
        {result.cancelled && <p>{CRAWL_CANCELLED_LABEL}</p>}
      </div>
      {headline !== null && <p className="text-sm text-text">{headline}</p>}
      {result.problems.length > 0 && (
        <ul
          aria-label={CRAWL_PROBLEMS_LABEL}
          className={`max-h-40 overflow-y-auto rounded-control border p-2 text-sm text-muted ${BORDER}`}
        >
          {result.problems.map((problem) => (
            <li
              key={`${problem.stage}\n${problem.reason}\n${problem.url}\n${problem.detail ?? ''}`}
              className="flex flex-wrap gap-x-2"
            >
              <span className="break-all text-text">{problemText(problem)}</span>
              <span className="break-all" title={problem.url}>
                {shortUrl(problem.url)}
              </span>
            </li>
          ))}
          {result.problemsDropped > 0 && <li>{moreProblemsText(result.problemsDropped)}</li>}
        </ul>
      )}
      {showFiles && result.files.length > 0 && (
        <ul
          aria-label={FOUND_FILES_LABEL}
          className={`h-48 overflow-y-auto rounded-control border p-2 text-sm text-muted ${BORDER}`}
        >
          {result.files.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
