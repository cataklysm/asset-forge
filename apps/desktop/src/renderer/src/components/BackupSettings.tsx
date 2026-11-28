import { useEffect, useId, useState } from 'react';
import { BACKUP_MESSAGES, type BackupEntry, type BackupStatus } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { formatDateTime } from '../format';
import { useExclusiveRun } from '../hooks/useExclusiveRun';
import {
  BACK_UP_NOW_LABEL,
  BACK_UP_NOW_TITLE,
  BACKUP_CHANGE_LOCATION_LABEL,
  BACKUP_CHANGE_LOCATION_TITLE,
  BACKUP_LOAD_FAILED,
  BACKUP_LOCATION_LABEL,
  BACKUP_RESET_LOCATION_TITLE,
  BACKUP_SECTION_TITLE,
  DELETE_BACKUP_CONFIRM_TITLE,
  DELETE_LABEL,
  LAST_BACKUP_LABEL,
  RESET_LABEL,
} from '../labels';
import { ALERT, BUTTON, SECTION_TITLE, WARNING } from '../ui';
import { CopiesRow, LastAttemptText, LocationText, OtherLineages, StatusRow } from './BackupStatusView';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsLoadState } from './SettingsLoadState';

/** Shows a newer status. */
type ShowStatus = (status: BackupStatus) => void;

/**
 * Lets the user pick another place; a cancelled pick keeps the view.
 *
 * @param show shows the status of the new place
 * @returns resolves once the answer is shown
 */
async function changeLocation(show: ShowStatus): Promise<void> {
  const next = await call('backup:changeLocation', {});
  if (next !== null) show(next);
}

/**
 * Keeps the backups in the workspace folder again.
 *
 * @param show shows the status of the default place
 * @returns resolves once the answer is shown
 */
async function resetLocation(show: ShowStatus): Promise<void> {
  show(await call('backup:resetLocation', {}));
}

/**
 * Backs the open workspace up at once, then reads the status again; a failed attempt shows as the last one.
 *
 * @param show shows the new status
 * @returns resolves once the new status is shown
 */
async function backUpNow(show: ShowStatus): Promise<void> {
  await call('backup:now', {});
  show(await call('backup:status', {}));
}

/**
 * Deletes one copy of another lineage.
 *
 * @param backupId the id of the copy from the latest status
 * @param show shows the status without it
 * @returns resolves once the answer is shown
 */
async function deleteBackup(backupId: string, show: ShowStatus): Promise<void> {
  show(await call('backup:delete', { backupId }));
}

/**
 * Loads the backup status on mount and on every retry.
 *
 * @returns the status, whether the last load failed, the setter and the retry
 */
function useBackupStatus(): { status: BackupStatus | null; failed: boolean; show: ShowStatus; retry(): void } {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    call('backup:status', {}).then(
      (value) => {
        if (active) setStatus(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };
  return { status, failed, show: setStatus, retry };
}

/**
 * The Backup section of the settings for the open workspace: the place, the last attempt, the copies and the
 * copies of other lineages.
 *
 * @returns the section
 */
export function BackupSettings() {
  const headingId = useId();
  const { status, failed, show, retry } = useBackupStatus();
  const { busy, error, run } = useExclusiveRun(messageOf);
  const [deleting, setDeleting] = useState<BackupEntry | null>(null);

  const confirmDelete = (backup: BackupEntry) =>
    void run(() => deleteBackup(backup.backupId, show)).then(() => setDeleting(null));

  return (
    <section aria-labelledby={headingId} className="flex max-w-4xl flex-col gap-4">
      <h3 id={headingId} className={SECTION_TITLE}>
        {BACKUP_SECTION_TITLE}
      </h3>
      {status === null ? (
        <SettingsLoadState failed={failed} failedMessage={BACKUP_LOAD_FAILED} onRetry={retry} />
      ) : (
        <StatusRows status={status} busy={busy} run={run} show={show} onDelete={setDeleting} />
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={DELETE_BACKUP_CONFIRM_TITLE}
        description={deleting === null ? undefined : formatDateTime(deleting.createdAt)}
        confirmLabel={DELETE_LABEL}
        busy={busy}
        onConfirm={() => deleting !== null && confirmDelete(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}

/** The props of `StatusRows`. */
interface StatusRowsProps {
  status: BackupStatus;
  /** A request runs: every button is disabled. */
  busy: boolean;
  /** Runs one request at a time; a refusal shows its message. */
  run(action: () => Promise<void>): Promise<void>;
  show: ShowStatus;
  /** Asks before a copy of another lineage is deleted. */
  onDelete(backup: BackupEntry): void;
}

/**
 * The rows of a loaded status with their buttons.
 *
 * @param props the status, the busy flag, the runner and the callbacks
 * @returns the rows
 */
function StatusRows({ status, busy, run, show, onDelete }: StatusRowsProps) {
  return (
    <div className="flex flex-col gap-2">
      {!status.reachable && (
        <p role="alert" className={WARNING}>
          {BACKUP_MESSAGES.backup_location_unreachable}
        </p>
      )}
      <LocationRow status={status} busy={busy} run={run} show={show} />
      <LastBackupRow status={status} busy={busy} run={run} show={show} />
      <CopiesRow status={status} />
      <OtherLineages backups={status.otherLineages} busy={busy} onDelete={onDelete} />
    </div>
  );
}

/** The props of the rows with actions. */
type ActionRowProps = Omit<StatusRowsProps, 'onDelete'>;

/**
 * The place of the backups with Change and Reset; Reset only for a chosen place.
 *
 * @param props the status, the busy flag, the runner and the setter
 * @returns the row
 */
function LocationRow({ status, busy, run, show }: ActionRowProps) {
  return (
    <StatusRow
      label={BACKUP_LOCATION_LABEL}
      actions={
        <>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            title={BACKUP_CHANGE_LOCATION_TITLE}
            onClick={() => void run(() => changeLocation(show))}
          >
            {BACKUP_CHANGE_LOCATION_LABEL}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy || status.location.kind === 'workspace'}
            title={BACKUP_RESET_LOCATION_TITLE}
            onClick={() => void run(() => resetLocation(show))}
          >
            {RESET_LABEL}
          </button>
        </>
      }
    >
      <LocationText location={status.location} />
    </StatusRow>
  );
}

/**
 * The last attempt with Back up now, disabled while any backup runs.
 *
 * @param props the status, the busy flag, the runner and the setter
 * @returns the row
 */
function LastBackupRow({ status, busy, run, show }: ActionRowProps) {
  return (
    <StatusRow
      label={LAST_BACKUP_LABEL}
      actions={
        <button
          type="button"
          className={BUTTON}
          disabled={busy || status.running}
          title={BACK_UP_NOW_TITLE}
          onClick={() => void run(() => backUpNow(show))}
        >
          {BACK_UP_NOW_LABEL}
        </button>
      }
    >
      <LastAttemptText last={status.last} />
    </StatusRow>
  );
}
