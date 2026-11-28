import { useEffect, useState } from 'react';
import { BACKUP_STALE_MESSAGE, type BackupListing } from '@assetforge/contracts';
import { ApiError, call, messageOf } from '../api';

/** The workspace whose backups are listed: a known one by id, or a folder by its path. */
export type RestoreTarget = { id: string } | { rootPath: string };

/** The latest listing and the chosen backup. */
export interface ListingState {
  /** The latest listing, or null before the first one arrived. */
  listing: BackupListing | null;
  /** The id of the chosen backup, or null. */
  selectedId: string | null;
}

/** What `useBackupListing` offers. */
export interface BackupListingControl extends ListingState {
  /** The message of a failed first load, or null. */
  loadError: string | null;
  /** The first load runs. */
  loading: boolean;
  select(backupId: string): void;
  /** Shows a newer listing; its newest backup is chosen. */
  show(listing: BackupListing): void;
}

/**
 * The state of a listing that just arrived: its newest backup is chosen.
 *
 * @param listing the listing
 * @returns the state
 */
export function stateOf(listing: BackupListing): ListingState {
  return { listing, selectedId: listing.backups[0]?.backupId ?? null };
}

/**
 * Lists the backups of the target.
 *
 * @param target the workspace by id or folder
 * @param pickFolder whether the main process first asks for another folder to list
 * @returns the listing with fresh ids
 */
export function fetchListing(target: RestoreTarget, pickFolder: boolean): Promise<BackupListing> {
  const request = 'id' in target ? { id: target.id } : { rootPath: target.rootPath };
  return call('workspace:backups', pickFolder ? { ...request, pickFolder: true } : request);
}

/**
 * Whether a refusal means the ids of the listing are no longer valid.
 *
 * @param error the refusal
 * @returns true for `Load the backups again`
 */
export function isStale(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'invalid_operation' && error.message === BACKUP_STALE_MESSAGE;
}

/**
 * Loads the listing of the target once while `open`, and keeps the chosen backup.
 *
 * @param open whether the dialog is shown
 * @param target the workspace by id or folder
 * @returns the listing state and its setters
 */
export function useBackupListing(open: boolean, target: RestoreTarget): BackupListingControl {
  const [state, setState] = useState<ListingState>({ listing: null, selectedId: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const id = 'id' in target ? target.id : null;
  const rootPath = 'rootPath' in target ? target.rootPath : null;

  useEffect(() => {
    if (!open) return;
    let active = true;
    fetchListing(id === null ? { rootPath: rootPath ?? '' } : { id }, false).then(
      (listing) => {
        if (active) setState(stateOf(listing));
      },
      (failure: unknown) => {
        if (active) setLoadError(messageOf(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [open, id, rootPath]);

  return {
    ...state,
    loadError,
    loading: state.listing === null && loadError === null,
    select: (selectedId) => setState((current) => ({ ...current, selectedId })),
    show: (listing) => {
      setLoadError(null);
      setState(stateOf(listing));
    },
  };
}
