import { backupFailedLine, SETTINGS_LABEL } from '../labels';
import { BUTTON, WARNING } from '../ui';
import { BUSY_TITLE } from './busy-title';

/** The props of `BackupBanner`. */
interface Props {
  /** The fixed reason of the failed last backup. */
  message: string;
  /** True while an import runs: Settings is then disabled. */
  busy: boolean;
  /** Opens the settings screen. */
  onSettings(): void;
}

/**
 * The banner line of a failed last backup, with the way to the Backup section of the settings.
 *
 * @param props the reason, the busy flag and the navigation
 * @returns the alert region
 */
export function BackupBanner({ message, busy, onSettings }: Props) {
  return (
    <div role="alert" className={`m-6 mb-0 flex items-center justify-between gap-4 ${WARNING}`}>
      <span className="min-w-0 break-words">{backupFailedLine(message)}</span>
      <div className="shrink-0">
        <button
          type="button"
          className={BUTTON}
          aria-disabled={busy || undefined}
          title={busy ? BUSY_TITLE : undefined}
          onClick={() => {
            if (!busy) onSettings();
          }}
        >
          {SETTINGS_LABEL}
        </button>
      </div>
    </div>
  );
}
