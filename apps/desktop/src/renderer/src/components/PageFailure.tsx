import { RETRY_LABEL } from '../labels';
import { ALERT, BUTTON } from '../ui';

// The failure of a page in a virtualised list: its fixed text beside Retry.

/**
 * The failure text of a page inside a row or tile, cut to one line with the whole text as its tooltip.
 *
 * @param props the failure text; absent when none was given
 * @returns the text, or nothing
 */
export function PageFailureText({ message }: { message: string | undefined | null }) {
  if (message === undefined || message === null) return null;
  return (
    <span title={message} className="min-w-0 truncate text-sm text-danger">
      {message}
    </span>
  );
}

/** The props of `ListRetry`. */
interface ListRetryProps {
  /** The failed page and its failure text (null without one). */
  failed: { page: number; message: string | null };
  /** Asks for the page again. */
  onRetry(page: number): void;
}

/**
 * The failure that takes the place of the whole list while its total is unknown: the text and Retry.
 *
 * @param props the failed page and the retry
 * @returns the failure block
 */
export function ListRetry({ failed, onRetry }: ListRetryProps) {
  return (
    <div className="flex flex-col items-start gap-3">
      {failed.message !== null && (
        <p role="alert" className={ALERT}>
          {failed.message}
        </p>
      )}
      <button type="button" className={BUTTON} onClick={() => onRetry(failed.page)}>
        {RETRY_LABEL}
      </button>
    </div>
  );
}
