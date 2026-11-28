import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { BACKUP_MESSAGES, type BackupEntry, type BackupStatus } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { formatDateTime } from '../format';
import { useBackupStatus } from '../hooks/useBackupStatus';
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

/** What the delete of one copy needs. */
interface DeleteRequest {
  backup: BackupEntry;
  /** The copies of other lineages shown when the delete was asked for. */
  shown: readonly BackupEntry[];
  show: ShowStatus;
  /** Receives the row index of the deleted copy once the answer is shown. */
  onDeleted(index: number): void;
}

/**
 * Deletes one copy of another lineage.
 *
 * @param request the copy, the shown copies and the callbacks
 * @returns resolves once the answer is shown
 */
async function deleteBackup(request: DeleteRequest): Promise<void> {
  const index = request.shown.findIndex((other) => other.backupId === request.backup.backupId);
  request.show(await call('backup:delete', { backupId: request.backup.backupId }));
  request.onDeleted(Math.max(index, 0));
}

/** Marks the Delete buttons of the copies of other lineages. */
const DELETE_BACKUP_SELECTOR = '[data-backup-delete]';
/** Marks Back up now, which takes the focus when no copy of another lineage is left. */
const BACK_UP_NOW_SELECTOR = '[data-back-up-now]';

/**
 * Focuses the Delete button of the row now at `index`, else the last row's, else Back up now.
 *
 * @param scope the section
 * @param index the row index of the deleted copy
 */
function focusNeighbour(scope: HTMLElement | null, index: number): void {
  const buttons = [...(scope?.querySelectorAll<HTMLElement>(DELETE_BACKUP_SELECTOR) ?? [])];
  (buttons[Math.min(index, buttons.length - 1)] ?? scope?.querySelector<HTMLElement>(BACK_UP_NOW_SELECTOR))?.focus();
}

/**
 * Moves the focus after a delete once the confirmation closed, since the deleted row took its button with it.
 *
 * @param sectionRef the section
 * @param confirmOpen whether the confirmation is still open
 * @returns the setter of the row index to focus next to
 */
function useFocusAfterDelete(sectionRef: RefObject<HTMLElement | null>, confirmOpen: boolean): (index: number) => void {
  // The row index of a deleted copy until the focus moved to its neighbour.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (confirmOpen || pending.current === null) return;
    focusNeighbour(sectionRef.current, pending.current);
    pending.current = null;
  }, [confirmOpen, sectionRef]);
  return (index) => {
    pending.current = index;
  };
}

/**
 * Brings the section into view and its heading into focus whenever the token changes, after the banner's Settings.
 *
 * @param headingRef the heading
 * @param focusToken changes once per request; null asks for nothing
 */
function useBringIntoView(headingRef: RefObject<HTMLElement | null>, focusToken: number | null): void {
  useEffect(() => {
    const heading = headingRef.current;
    if (focusToken === null || heading === null) return;
    heading.scrollIntoView?.({ block: 'start' });
    heading.focus();
  }, [focusToken, headingRef]);
}

/**
 * The Backup section of the settings for the open workspace: the place, the last attempt, the copies and the
 * copies of other lineages. It reads the status again whenever the shell's backup state moves.
 *
 * @param props a token that brings the section into view and focuses its heading whenever it changes
 * @returns the section
 */
export function BackupSettings({ focusToken = null }: { focusToken?: number | null }) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { status, failed, show, retry } = useBackupStatus();
  const { busy, error, run } = useExclusiveRun(messageOf);
  const [deleting, setDeleting] = useState<BackupEntry | null>(null);
  const onDeleted = useFocusAfterDelete(sectionRef, deleting !== null);
  useBringIntoView(headingRef, focusToken);

  const confirmDelete = (backup: BackupEntry) =>
    void run(() => deleteBackup({ backup, shown: status?.otherLineages ?? [], show, onDeleted })).then(() =>
      setDeleting(null),
    );

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="flex max-w-4xl flex-col gap-4">
      <h3 ref={headingRef} id={headingId} tabIndex={-1} className={`${SECTION_TITLE} outline-none`}>
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
          data-back-up-now=""
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
