import type { ImportProgress } from '@assetforge/contracts';
import { importProgressValue } from '../import-progress';
import { IMPORT_CANCEL_LABEL, IMPORT_CANCEL_TITLE, IMPORT_PROGRESS_LABEL, importCountText } from '../labels';
import { BUTTON, MUTED } from '../ui';

// The progress of a running import in place of the import button.

interface Props {
  /** The progress of the running import. */
  progress: ImportProgress;
  /** Asks the import to stop after the current item. */
  onCancel(): void;
}

/**
 * A running import: '<done> of <total>', a bar that also moves within one file, and Cancel.
 *
 * @param props the progress and the cancel
 * @returns the view
 */
export function ImportProgressView({ progress, onCancel }: Props) {
  const percent = importProgressValue(progress) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className={`text-sm tabular-nums ${MUTED}`}>{importCountText(progress.done, progress.total)}</span>
      <div
        role="progressbar"
        aria-label={IMPORT_PROGRESS_LABEL}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={importCountText(progress.done, progress.total)}
        className="h-2 w-32 overflow-hidden rounded-full border border-line bg-surface"
      >
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <button
        type="button"
        className={BUTTON}
        title={IMPORT_CANCEL_TITLE}
        disabled={progress.cancelling}
        onClick={onCancel}
      >
        {IMPORT_CANCEL_LABEL}
      </button>
    </div>
  );
}
