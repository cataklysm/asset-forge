import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BackupAttempt, BackupEntry, BackupStatus } from '@assetforge/contracts';
import { formatBytes, formatDateTime } from '../format';
import { failureMessage } from '../hooks/useBackupState';
import {
  BACKUP_COPIES_LABEL,
  BACKUP_COPIES_TITLE,
  BACKUP_LOCATION_LABEL,
  BACKUP_SUCCEEDED_LABEL,
  DELETE_BACKUP_TITLE,
  LAST_BACKUP_LABEL,
  MIGRATIONS_TITLE,
  NO_BACKUP_YET_LABEL,
  OTHER_LINEAGES_HEADING_TITLE,
  OTHER_LINEAGES_TITLE,
  WORKSPACE_FOLDER_LABEL,
  WORKSPACE_FOLDER_TITLE,
  backupCopiesText,
  deleteBackupLabel,
  migrationsText,
} from '../labels';
import { BORDER, ICON_BUTTON, LABEL, MUTED, PANEL_TITLE } from '../ui';

/**
 * One caption and its value, with optional actions at the end.
 *
 * @param props the caption, the value and the actions
 * @returns the row
 */
export function StatusRow({ label, children, actions }: { label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-4">
      <span className={`w-28 shrink-0 ${LABEL}`}>{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The place the backups go to: `Workspace folder`, or the chosen path with the path as tooltip.
 *
 * @param props the location of the status
 * @returns the text
 */
export function LocationText({ location }: { location: BackupStatus['location'] }) {
  if (location.kind === 'workspace' || location.path === null)
    return <span title={WORKSPACE_FOLDER_TITLE}>{WORKSPACE_FOLDER_LABEL}</span>;
  return <span title={location.path}>{location.path}</span>;
}

/**
 * The last attempt: its time and `Succeeded` or its fixed reason, else `None`.
 *
 * @param props the last attempt, or null
 * @returns the text
 */
export function LastAttemptText({ last }: { last: BackupAttempt | null }) {
  if (last === null) return <span className={MUTED}>{NO_BACKUP_YET_LABEL}</span>;
  return (
    <>
      <span className={MUTED}>{formatDateTime(last.at)}</span>{' '}
      <span>{last.ok ? BACKUP_SUCCEEDED_LABEL : failureMessage(last)}</span>
    </>
  );
}

/**
 * The count and total size of the copies of the workspace's own lineage.
 *
 * @param props the status
 * @returns the row
 */
export function CopiesRow({ status }: { status: BackupStatus }) {
  return (
    <StatusRow label={BACKUP_COPIES_LABEL}>
      <span title={BACKUP_COPIES_TITLE}>{backupCopiesText(status.count, formatBytes(status.totalBytes))}</span>
    </StatusRow>
  );
}

/** The props of `OtherLineages`. */
interface OtherLineagesProps {
  backups: readonly BackupEntry[];
  /** While a request runs Delete is disabled. */
  busy: boolean;
  /** Asks before the copy is deleted. */
  onDelete(backup: BackupEntry): void;
}

/**
 * The copies of other lineages in the place, each with Delete; nothing when there are none.
 *
 * @param props the copies, the busy flag and the delete callback
 * @returns the list, or null
 */
export function OtherLineages({ backups, busy, onDelete }: OtherLineagesProps) {
  if (backups.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className={PANEL_TITLE} title={OTHER_LINEAGES_HEADING_TITLE}>
        {OTHER_LINEAGES_TITLE}
      </h4>
      <ul className={`rounded-control border ${BORDER}`}>
        {backups.map((backup) => {
          const when = formatDateTime(backup.createdAt);
          return (
            <li
              key={backup.backupId}
              className={`flex items-center gap-3 border-b px-3 py-1 last:border-b-0 ${BORDER}`}
            >
              <span className="flex-1 whitespace-nowrap">{when}</span>
              <span className={MUTED}>{formatBytes(backup.sizeBytes)}</span>
              <span className={MUTED} title={MIGRATIONS_TITLE}>
                {migrationsText(backup.appliedMigrations)}
              </span>
              <button
                type="button"
                className={ICON_BUTTON}
                disabled={busy}
                title={DELETE_BACKUP_TITLE}
                aria-label={deleteBackupLabel(when)}
                data-backup-delete=""
                onClick={() => onDelete(backup)}
              >
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
