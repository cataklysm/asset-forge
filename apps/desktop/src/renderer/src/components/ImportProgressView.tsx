import type { ImportProgress } from '@assetforge/contracts';
import { importProgressValue, type ImportProgressState } from '../import-progress';
import {
  IMPORT_CANCEL_LABEL,
  IMPORT_CANCEL_TITLE,
  IMPORT_PROGRESS_LABEL,
  importCountText,
  IMPORTING_TEXT,
} from '../labels';
import { BUTTON, MUTED } from '../ui';

// The progress of a running import in place of the import button.

/**
 * What a screen shows of its import: the progress once known, the plain busy text while the import call runs
 * without one, and nothing while the file picker or the ZIP choice is still open.
 *
 * @param props the screen's import progress state
 * @returns the status, or nothing
 */
export function ImportStatus({ state }: { state: ImportProgressState }) {
  if (state.progress !== null) return <ImportProgressView progress={state.progress} onCancel={state.cancel} />;
  if (!state.isRunning) return null;
  return <span className={`text-sm ${MUTED}`}>{IMPORTING_TEXT}</span>;
}

/** The props of the progress view. */
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
