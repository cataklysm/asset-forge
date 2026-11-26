import { X } from 'lucide-react';
import { ALERT, BORDER, ICON_BUTTON_INLINE } from '../ui';

export interface ResultFailure {
  /** Unique within the strip (e.g. a file id or the index of a source); names may repeat. */
  key: string;
  name: string;
  message: string;
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
