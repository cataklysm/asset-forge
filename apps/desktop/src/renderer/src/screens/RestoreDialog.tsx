import { RefreshCw } from 'lucide-react';
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
  RETRY_LABEL,
  START_EMPTY_CONFIRM_TITLE,
  START_EMPTY_LABEL,
  START_EMPTY_TITLE,
} from '../labels';
import { ALERT, BUTTON, ICON_BUTTON } from '../ui';
import { BackupRadioList } from './BackupRadioList';
import { isStale, useBackupListing, type BackupListingControl, type RestoreTarget } from './restore-listing';

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
  listing: BackupListingControl;
  onRestored(summary: WorkspaceSummary): void;
}

/**
 * Restores the chosen backup; a stale refusal lists the place again (or marks a picked list stale) before the
 * refusal is shown.
 *
 * @param request the folder, the backup id, the listing and the callback
 * @returns resolves once the workspace was opened
 */
async function restoreBackup(request: RestoreRequest): Promise<void> {
  try {
    request.onRestored(await call('workspace:restore', { rootPath: request.rootPath, backupId: request.backupId }));
  } catch (failure) {
    if (isStale(failure)) request.listing.refused();
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

/** The props of `RestoreButtons`. */
interface ButtonProps {
  /** A restore or an empty start runs: every button is disabled, Cancel too. */
  opening: boolean;
  /** A listing request runs: Choose folder and Restore wait for it. */
  listing: boolean;
  /** A backup is chosen and its id is still valid. */
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
  const { opening, listing } = props;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        className={BUTTON}
        disabled={opening || listing}
        title={CHOOSE_FOLDER_TITLE}
        onClick={props.onChooseFolder}
      >
        {CHOOSE_FOLDER_LABEL}
      </button>
      {!props.databaseExists && (
        <button
          type="button"
          className={BUTTON}
          disabled={opening}
          title={START_EMPTY_TITLE}
          onClick={props.onStartEmpty}
        >
          {START_EMPTY_LABEL}
        </button>
      )}
      <button
        type="button"
        className={BUTTON}
        disabled={opening || listing || !props.canRestore}
        title={RESTORE_BACKUP_BUTTON_TITLE}
        onClick={props.onRestore}
      >
        {RESTORE_LABEL}
      </button>
      <button ref={props.cancelRef} type="button" className={BUTTON} disabled={opening} onClick={props.onClose}>
        {CANCEL_LABEL}
      </button>
    </div>
  );
}

/**
 * The message of a failed listing request, with Retry when it listed the place of the target.
 *
 * @param props the listing and the lock
 * @returns the alert, or null
 */
function ListingFailure({ listing, locked }: { listing: BackupListingControl; locked: boolean }) {
  if (listing.error === null) return null;
  return (
    <div className="flex items-start gap-2">
      <p role="alert" className={`flex-1 ${ALERT}`}>
        {listing.error}
      </p>
      {listing.retryable && (
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={locked}
          title={RETRY_LABEL}
          aria-label={RETRY_LABEL}
          onClick={listing.reload}
        >
          <RefreshCw size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The props of `ListingView`. */
interface ListingViewProps {
  listing: BackupListingControl;
  markLineage: boolean;
  locked: boolean;
  /** The message of the last refused restore or empty start. */
  message: string | null;
}

/**
 * The alert of an unreachable place, the list of backups and the messages of the last failures.
 *
 * @param props the listing, the marker flag, the lock and the message
 * @returns the content above the buttons
 */
function ListingView({ listing, markLineage, locked, message }: ListingViewProps) {
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
      <ListingFailure listing={listing} locked={locked} />
      {message !== null && (
        <p role="alert" className={ALERT}>
          {message}
        </p>
      )}
    </>
  );
}

/** What `useRestoreActions` offers. */
interface RestoreActions {
  /** A restore or an empty start runs. */
  opening: boolean;
  /** The message of the last refused restore or empty start. */
  error: string | null;
  confirming: Confirming;
  setConfirming(confirming: Confirming): void;
  /** Restores the chosen backup, one run at a time; the confirmation closes when it ends. */
  restore(): void;
  /** Starts the workspace empty, one run at a time; the confirmation closes when it ends. */
  empty(): void;
  /** Drops the last message and lets the user pick a folder to list. */
  chooseFolder(): void;
}

/**
 * The replacing actions of the dialog, one at a time, and their confirmation.
 *
 * @param props the folder and the callback with the opened workspace
 * @param listing the listing, which a stale refusal reloads or marks
 * @returns the flags and the actions
 */
function useRestoreActions(
  { rootPath, onRestored }: Pick<Props, 'rootPath' | 'onRestored'>,
  listing: BackupListingControl,
): RestoreActions {
  const { busy: opening, error, setError, run } = useExclusiveRun(messageOf);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const selectedId = listing.selectedId;
  const settle = (action: () => Promise<void>) => void run(action).then(() => setConfirming(null));
  const restore = () => {
    if (selectedId !== null) settle(() => restoreBackup({ rootPath, backupId: selectedId, listing, onRestored }));
  };
  const empty = () => settle(() => startEmpty(rootPath, onRestored));
  const chooseFolder = () => {
    setError(null);
    listing.pick();
  };
  return { opening, error, confirming, setConfirming, restore, empty, chooseFolder };
}

/**
 * Lists the backups of a workspace and restores one, or starts the workspace empty when its database is missing.
 * Only a running restore or empty start holds Cancel and Esc back, since its late success would open the workspace
 * after the dialog closed; a listing that hangs never does.
 *
 * @param props the target, the folder, the database flag and the callbacks
 * @returns the dialog and its confirmations
 */
export function RestoreDialog({ open, target, rootPath, databaseExists, onRestored, onClose }: Props) {
  const listing = useBackupListing(open, target);
  const actions = useRestoreActions({ rootPath, onRestored }, listing);
  const { opening, error, setConfirming, restore, chooseFolder } = actions;
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Dialog
        open={open}
        title={RESTORE_DIALOG_TITLE}
        onClose={() => !opening && onClose()}
        initialFocusRef={cancelRef}
      >
        <div className="flex flex-col gap-4">
          <ListingView
            listing={listing}
            markLineage={databaseExists}
            locked={opening || listing.loading}
            message={error}
          />
          <RestoreButtons
            opening={opening}
            listing={listing.loading}
            canRestore={listing.selectedId !== null && !listing.stale}
            databaseExists={databaseExists}
            cancelRef={cancelRef}
            onChooseFolder={chooseFolder}
            onStartEmpty={() => setConfirming('empty')}
            onRestore={() => (databaseExists ? setConfirming('restore') : restore())}
            onClose={onClose}
          />
        </div>
      </Dialog>
      <ReplaceConfirmation actions={actions} />
    </>
  );
}

/**
 * The question before a restore replaces the database or an empty start drops it.
 *
 * @param props the actions of the dialog
 * @returns the confirmation
 */
function ReplaceConfirmation({ actions }: { actions: RestoreActions }) {
  const { confirming, opening, empty, restore, setConfirming } = actions;
  return (
    <ConfirmDialog
      open={confirming !== null}
      title={confirming === 'empty' ? START_EMPTY_CONFIRM_TITLE : RESTORE_CONFIRM_TITLE}
      confirmLabel={confirming === 'empty' ? START_EMPTY_LABEL : RESTORE_LABEL}
      busy={opening}
      onConfirm={confirming === 'empty' ? empty : restore}
      onCancel={() => setConfirming(null)}
    />
  );
}
