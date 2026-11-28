import { useRef, useState, type RefObject } from 'react';
import { BACKUP_MESSAGES, type WorkspaceSummary } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Dialog } from '../components/Dialog';
import { useExclusiveRun } from '../hooks/useExclusiveRun';
import {
  CANCEL_LABEL,
  CHOOSE_FOLDER_LABEL,
  CHOOSE_FOLDER_TITLE,
  RESTORE_BACKUP_BUTTON_TITLE,
  RESTORE_CONFIRM_TITLE,
  RESTORE_DIALOG_TITLE,
  RESTORE_LABEL,
  START_EMPTY_CONFIRM_TITLE,
  START_EMPTY_LABEL,
  START_EMPTY_TITLE,
} from '../labels';
import { ALERT, BUTTON } from '../ui';
import { BackupRadioList } from './BackupRadioList';
import {
  fetchListing,
  isStale,
  useBackupListing,
  type BackupListingControl,
  type RestoreTarget,
} from './restore-listing';

/** The props of `RestoreDialog`. */
interface Props {
  /** Whether the dialog is shown. */
  open: boolean;
  /** The workspace whose backups are listed. */
  target: RestoreTarget;
  /** The workspace folder the restore and the empty start open. */
  rootPath: string;
  /** Whether the workspace still has a database, which a restore then replaces after asking. */
  databaseExists: boolean;
  /** Called with the workspace once it was restored or started empty. */
  onRestored(summary: WorkspaceSummary): void;
  onClose(): void;
}

/** The two replacing actions that ask first. */
type Confirming = 'restore' | 'empty' | null;

/** What the restore of the chosen backup needs. */
interface RestoreRequest {
  rootPath: string;
  backupId: string;
  target: RestoreTarget;
  listing: BackupListingControl;
  onRestored(summary: WorkspaceSummary): void;
}

/**
 * Restores the chosen backup; stale ids load the list again before the refusal is shown.
 *
 * @param request the folder, the backup id, the listing and the callback
 * @returns resolves once the workspace was opened
 */
async function restoreBackup(request: RestoreRequest): Promise<void> {
  try {
    request.onRestored(await call('workspace:restore', { rootPath: request.rootPath, backupId: request.backupId }));
  } catch (failure) {
    if (isStale(failure)) request.listing.show(await fetchListing(request.target, false));
    throw failure;
  }
}

/**
 * Opens the workspace with a new, empty database.
 *
 * @param rootPath the workspace folder
 * @param onRestored the callback with the opened workspace
 * @returns resolves once the workspace was opened
 */
async function startEmpty(rootPath: string, onRestored: (summary: WorkspaceSummary) => void): Promise<void> {
  onRestored(await call('workspace:open', { rootPath, startEmpty: true }));
}

/**
 * Lists the backups of a folder the user picks and shows them.
 *
 * @param target the workspace by id or folder
 * @param listing the listing that shows the answer
 * @returns resolves once the new listing is shown
 */
async function chooseFolder(target: RestoreTarget, listing: BackupListingControl): Promise<void> {
  listing.show(await fetchListing(target, true));
}

/** The props of `RestoreButtons`. */
interface ButtonProps {
  /** A request runs or the list loads: every button is disabled. */
  locked: boolean;
  /** A backup is chosen. */
  canRestore: boolean;
  /** Start empty is offered only while the database is missing. */
  databaseExists: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onChooseFolder(): void;
  onStartEmpty(): void;
  onRestore(): void;
  onClose(): void;
}

/**
 * The buttons of the restore dialog: Choose folder, Start empty, Restore and Cancel.
 *
 * @param props the flags and the callbacks
 * @returns the button row
 */
function RestoreButtons(props: ButtonProps) {
  const { locked } = props;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        className={BUTTON}
        disabled={locked}
        title={CHOOSE_FOLDER_TITLE}
        onClick={props.onChooseFolder}
      >
        {CHOOSE_FOLDER_LABEL}
      </button>
      {!props.databaseExists && (
        <button
          type="button"
          className={BUTTON}
          disabled={locked}
          title={START_EMPTY_TITLE}
          onClick={props.onStartEmpty}
        >
          {START_EMPTY_LABEL}
        </button>
      )}
      <button
        type="button"
        className={BUTTON}
        disabled={locked || !props.canRestore}
        title={RESTORE_BACKUP_BUTTON_TITLE}
        onClick={props.onRestore}
      >
        {RESTORE_LABEL}
      </button>
      <button ref={props.cancelRef} type="button" className={BUTTON} disabled={locked} onClick={props.onClose}>
        {CANCEL_LABEL}
      </button>
    </div>
  );
}

/**
 * The alert of an unreachable place, the list of backups and the message of the last refusal.
 *
 * @param props the listing, the marker flag, the lock and the message
 * @returns the content above the buttons
 */
function ListingView({
  listing,
  markLineage,
  locked,
  message,
}: {
  listing: BackupListingControl;
  markLineage: boolean;
  locked: boolean;
  message: string | null;
}) {
  return (
    <>
      {listing.listing?.unreachable === true && (
        <p role="alert" className={ALERT}>
          {BACKUP_MESSAGES.backup_location_unreachable}
        </p>
      )}
      {listing.listing !== null && (
        <BackupRadioList
          backups={listing.listing.backups}
          selectedId={listing.selectedId}
          markLineage={markLineage}
          disabled={locked}
          onSelect={listing.select}
        />
      )}
      {message !== null && (
        <p role="alert" className={ALERT}>
          {message}
        </p>
      )}
    </>
  );
}

/**
 * Lists the backups of a workspace and restores one, or starts the workspace empty when its database is missing.
 *
 * @param props the target, the folder, the database flag and the callbacks
 * @returns the dialog and its confirmations
 */
export function RestoreDialog({ open, target, rootPath, databaseExists, onRestored, onClose }: Props) {
  const listing = useBackupListing(open, target);
  const { busy, error, run } = useExclusiveRun(messageOf);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = busy || listing.loading;
  const selectedId = listing.selectedId;
  const settle = (action: () => Promise<void>) => void run(action).then(() => setConfirming(null));
  const restore = () =>
    selectedId !== null && settle(() => restoreBackup({ rootPath, backupId: selectedId, target, listing, onRestored }));
  const empty = () => settle(() => startEmpty(rootPath, onRestored));
  const message = error ?? listing.loadError;

  return (
    <>
      <Dialog open={open} title={RESTORE_DIALOG_TITLE} onClose={() => !locked && onClose()} initialFocusRef={cancelRef}>
        <div className="flex flex-col gap-4">
          <ListingView listing={listing} markLineage={databaseExists} locked={locked} message={message} />
          <RestoreButtons
            locked={locked}
            canRestore={selectedId !== null}
            databaseExists={databaseExists}
            cancelRef={cancelRef}
            onChooseFolder={() => void run(() => chooseFolder(target, listing))}
            onStartEmpty={() => setConfirming('empty')}
            onRestore={() => (databaseExists ? setConfirming('restore') : restore())}
            onClose={onClose}
          />
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'empty' ? START_EMPTY_CONFIRM_TITLE : RESTORE_CONFIRM_TITLE}
        confirmLabel={confirming === 'empty' ? START_EMPTY_LABEL : RESTORE_LABEL}
        busy={busy}
        onConfirm={confirming === 'empty' ? empty : restore}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
