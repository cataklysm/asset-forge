import { Database, History } from 'lucide-react';
import type { BackupEntry } from '@assetforge/contracts';
import { formatBytes, formatDateTime } from '../format';
import {
  BACKUP_LIST_LABEL,
  MIGRATIONS_TITLE,
  NO_BACKUPS_LABEL,
  OTHER_LINEAGE_TITLE,
  PRE_MIGRATION_TITLE,
  migrationsText,
} from '../labels';
import { BORDER, MUTED } from '../ui';

/** The props of `BackupRadioList`. */
interface Props {
  /** The backups of the latest listing, newest first. */
  backups: readonly BackupEntry[];
  /** The id of the chosen backup, or null. */
  selectedId: string | null;
  /** Whether the other-lineage marker means something: only beside an existing database. */
  markLineage: boolean;
  /** While a request runs the choice is fixed. */
  disabled: boolean;
  onSelect(backupId: string): void;
}

/**
 * A marker icon whose meaning is its tooltip and, for screen readers, its hidden text.
 *
 * @param props the tooltip and the icon
 * @returns the marker
 */
function Marker({ title, icon }: { title: string; icon: 'pre_migration' | 'other_lineage' }) {
  const Icon = icon === 'pre_migration' ? History : Database;
  return (
    <span title={title} className={`inline-flex items-center ${MUTED}`}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{title}</span>
    </span>
  );
}

/**
 * One backup as a radio row: time, size, migration count and markers.
 *
 * @param props the backup, the list state and the callback
 * @returns the row
 */
function BackupRow({
  backup,
  selectedId,
  markLineage,
  disabled,
  onSelect,
}: { backup: BackupEntry } & Omit<Props, 'backups'>) {
  return (
    <div className={`border-b last:border-b-0 ${BORDER}`}>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
        <input
          type="radio"
          name="backup"
          value={backup.backupId}
          checked={backup.backupId === selectedId}
          disabled={disabled}
          onChange={() => onSelect(backup.backupId)}
        />
        <span className="flex-1 whitespace-nowrap">{formatDateTime(backup.createdAt)}</span>
        <span className={`whitespace-nowrap ${MUTED}`}>{formatBytes(backup.sizeBytes)}</span>
        <span className={`whitespace-nowrap ${MUTED}`} title={MIGRATIONS_TITLE}>
          {migrationsText(backup.appliedMigrations)}
        </span>
        <span className="flex w-10 justify-end gap-1">
          {backup.origin === 'pre_migration' && <Marker title={PRE_MIGRATION_TITLE} icon="pre_migration" />}
          {markLineage && !backup.sameLineage && <Marker title={OTHER_LINEAGE_TITLE} icon="other_lineage" />}
        </span>
      </label>
    </div>
  );
}

/**
 * The backups of the latest listing as a radio list, or the empty line.
 *
 * @param props the backups, the chosen id, the marker flag, the disabled flag and the callback
 * @returns the list
 */
export function BackupRadioList({ backups, ...rest }: Props) {
  if (backups.length === 0) return <p className={`text-sm ${MUTED}`}>{NO_BACKUPS_LABEL}</p>;
  return (
    <div
      role="radiogroup"
      aria-label={BACKUP_LIST_LABEL}
      className={`max-h-80 overflow-auto rounded-control border ${BORDER}`}
    >
      {backups.map((backup) => (
        <BackupRow key={backup.backupId} backup={backup} {...rest} />
      ))}
    </div>
  );
}
