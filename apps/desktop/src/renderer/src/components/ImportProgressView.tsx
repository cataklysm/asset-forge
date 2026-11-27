import type { ImportProgress } from '@assetforge/contracts';
import { importProgressValue } from '../import-progress';
import { IMPORT_CANCEL_LABEL, IMPORT_CANCEL_TITLE, IMPORT_PROGRESS_LABEL, importCountText } from '../labels';
import { BUTTON, MUTED } from '../ui';

interface Props {
  progress: ImportProgress;
  onCancel(): void;
}

/** A running import: '<done> of <total>', a bar that also moves within one file, and Cancel. */
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
