import { X } from 'lucide-react';
import type { FileBatchResult, ImportResult } from '@assetforge/contracts';
import { ApiError, describeError } from '../api';
import { ALERT, BORDER, ICON_BUTTON_INLINE } from '../ui';

export interface ResultFailure {
  /** Unique within the strip (e.g. a file id or the index of a source); names may repeat. */
  key: string;
  name: string;
  message: string;
}

/** The file name of a picked source path; the rest of the path never reaches the screen. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** One failure per import result with an error, named by its source's file name. */
export function importFailures(results: readonly ImportResult[]): ResultFailure[] {
  return results.flatMap((r, index) =>
    r.error === null ? [] : [{ key: `${index}:${r.sourcePath}`, name: baseName(r.sourcePath), message: r.error }],
  );
}

/** One failure per item of a per-item file batch (`files:assignMany`, `files:trashMany`, …) with an error. */
export function assignFailures(items: FileBatchResult['items'], nameOf: (fileId: string) => string): ResultFailure[] {
  return items.flatMap((item) =>
    item.error === null
      ? []
      : [{ key: item.fileId, name: nameOf(item.fileId), message: describeError(new ApiError(item.error.code, item.error.message)) }],
  );
}

interface Props {
  title: string;
  failures: readonly ResultFailure[];
  onDismiss(): void;
}

/** The outcome of a batch: a title such as "3 imported, 1 failed" and one row per failure. */
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
          <ul className="space-y-0.5 text-sm">
            {failures.map((failure) => (
              <li key={failure.key} className="break-words">
                <span className="font-semibold">{failure.name}</span>: {failure.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className={ICON_BUTTON_INLINE} aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
