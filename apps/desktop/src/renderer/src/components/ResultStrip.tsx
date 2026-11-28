import { X } from 'lucide-react';
import type { FileBatchResult, ImportResult } from '@assetforge/contracts';
import { ApiError, describeError } from '../api';
import { baseName } from '../import-result';
import { moreFailedText } from '../labels';
import { ALERT, BORDER, ICON_BUTTON_INLINE } from '../ui';

// The outcome of a batch above a list, and the failures and titles that feed it.

/** One failed item of a batch. */
export interface ResultFailure {
  /** Unique within the strip (e.g. a file id or the index of a source); names may repeat. */
  key: string;
  /** The item's name as shown. */
  name: string;
  /** The error message. */
  message: string;
}

/** What a result strip shows. */
export interface BatchResult {
  /** The title, such as "3 imported, 1 failed". */
  title: string;
  /** One entry per failed item. */
  failures: ResultFailure[];
}

/**
 * One failure per import result with an error: an archive entry is named
 * '<entry name> (<archive file name>)', any other result by its source's file name.
 *
 * @param results the import results
 * @returns the failures in result order
 */
export function importFailures(results: readonly ImportResult[]): ResultFailure[] {
  return results.flatMap((result, index) => {
    if (result.error === null) return [];
    const source = baseName(result.sourcePath);
    const name = result.entryName === null ? source : `${result.entryName} (${source})`;
    return [{ key: `${index}:${result.sourcePath}`, name, message: result.error }];
  });
}

/**
 * One failure per item of a per-item file batch (`files:assignMany`, `files:trashMany`, …) with an error.
 *
 * @param items the batch's items
 * @param nameOf the shown name of a file
 * @returns the failures in item order
 */
export function assignFailures(items: FileBatchResult['items'], nameOf: (fileId: string) => string): ResultFailure[] {
  return items.flatMap((item) =>
    item.error === null
      ? []
      : [
          {
            key: item.fileId,
            name: nameOf(item.fileId),
            message: describeError(new ApiError(item.error.code, item.error.message)),
          },
        ],
  );
}

/**
 * The strip of a batch that had failures, such as "3 deleted, 1 failed"; nothing when every item went through.
 *
 * @param done the number of items that went through
 * @param verb what happened to them, such as `deleted`
 * @param failures the failed items
 * @returns the strip's content, or null when nothing failed
 */
export function batchResult(done: number, verb: string, failures: ResultFailure[]): BatchResult | null {
  return failures.length === 0 ? null : { title: `${done} ${verb}, ${failures.length} failed`, failures };
}

/** The most failure lines a strip shows; a count line stands for the rest. */
export const MAX_FAILURE_LINES = 100;

/** The props of the strip. */
interface Props {
  /** The title, such as "3 imported, 1 failed". */
  title: string;
  /** One row per failure; none shows a status instead of an alert. */
  failures: readonly ResultFailure[];
  /** Hides the strip. */
  onDismiss(): void;
}

/**
 * The outcome of a batch: a title such as "3 imported, 1 failed" and one row per failure, at most
 * `MAX_FAILURE_LINES` in a scroll box of bounded height and a count line for the rest.
 *
 * @param props the title, the failures and the dismiss action
 * @returns the strip
 */
export function ResultStrip({ title, failures, onDismiss }: Props) {
  const failed = failures.length > 0;
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={`flex items-start gap-3 ${failed ? ALERT : `rounded-control border bg-surface p-3 text-text ${BORDER}`}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p>{title}</p>
        {failed && (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-sm">
            {failures.slice(0, MAX_FAILURE_LINES).map((failure) => (
              <li key={failure.key} className="break-words">
                <span className="font-semibold">{failure.name}</span>: {failure.message}
              </li>
            ))}
          </ul>
        )}
        {failures.length > MAX_FAILURE_LINES && (
          <p className="text-sm">{moreFailedText(failures.length - MAX_FAILURE_LINES)}</p>
        )}
      </div>
      <button type="button" className={ICON_BUTTON_INLINE} aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
