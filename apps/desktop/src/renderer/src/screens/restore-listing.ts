import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { BACKUP_STALE_MESSAGE, type BackupListing } from '@assetforge/contracts';
import { ApiError, call, messageOf } from '../api';

/** The workspace whose backups are listed: a known one by id, or a folder by its path. */
export type RestoreTarget = { id: string } | { rootPath: string };

/** Where a listing came from: the place of the target, or a folder the user picked. */
export type ListingSource = 'default' | 'picked';

/** The listing of one target and the requests for it. */
export interface ListingState {
  /** The target the state belongs to (`targetKey`). */
  key: string;
  /** The latest listing, or null before the first one arrived. */
  listing: BackupListing | null;
  /** The id of the chosen backup, or null. */
  selectedId: string | null;
  /** Where the shown listing came from. */
  source: ListingSource;
  /** A restore was refused as stale on a picked listing: its ids are no longer valid until the folder is chosen again. */
  stale: boolean;
  /** The message of the last failed listing request, or null. */
  error: string | null;
  /** Where the last failed listing request went. */
  failedSource: ListingSource | null;
  /** The listing request that runs, or null. */
  pending: ListingSource | null;
}

/** What `useBackupListing` offers. */
export interface BackupListingControl {
  listing: BackupListing | null;
  selectedId: string | null;
  /** The ids of the shown listing were refused as stale. */
  stale: boolean;
  /** The message of the last failed listing request, or null. */
  error: string | null;
  /** The failed request listed the place of the target, so Retry can ask again. */
  retryable: boolean;
  /** A listing request runs. */
  loading: boolean;
  select(backupId: string): void;
  /** Lists the place of the target again. */
  reload(): void;
  /** Lists a folder the user picks. */
  pick(): void;
  /** A restore was refused as stale: the place is listed again, a picked listing is marked stale. */
  refused(): void;
}

/**
 * The key that tells two targets apart.
 *
 * @param target the workspace by id or folder
 * @returns the key
 */
export function targetKey(target: RestoreTarget): string {
  return 'id' in target ? `id:${target.id}` : `root:${target.rootPath}`;
}

/**
 * The state of a target before its first answer: the first listing runs.
 *
 * @param key the target's key
 * @returns the state
 */
function freshState(key: string): ListingState {
  return {
    key,
    listing: null,
    selectedId: null,
    source: 'default',
    stale: false,
    error: null,
    failedSource: null,
    pending: 'default',
  };
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

/** What one listing request reads and writes. */
interface Requester {
  /** The number of the latest request; an answer of an older one, or after a close, is dropped. */
  latest: MutableRefObject<number>;
  setState: Dispatch<SetStateAction<ListingState>>;
  target: RestoreTarget;
  key: string;
}

/**
 * Applies a change to the state of the requester's target, unless a newer request or a close superseded it.
 *
 * @param requester the request tracking and the setter
 * @param token the number of the request that answered
 * @param change the change
 */
function applyAnswer(requester: Requester, token: number, change: (state: ListingState) => ListingState): void {
  if (token !== requester.latest.current) return;
  requester.setState((current) => change(current.key === requester.key ? current : freshState(requester.key)));
}

/**
 * Sends one listing request; the answer replaces the listing and chooses its newest backup.
 *
 * @param requester the request tracking, the setter and the target
 * @param source the place of the target, or a folder the user picks
 */
function sendRequest(requester: Requester, source: ListingSource): void {
  requester.latest.current += 1;
  const token = requester.latest.current;
  fetchListing(requester.target, source === 'picked').then(
    (listing) =>
      applyAnswer(requester, token, (state) => ({
        ...state,
        listing,
        selectedId: listing.backups[0]?.backupId ?? null,
        source,
        stale: false,
        error: null,
        failedSource: null,
        pending: null,
      })),
    (failure: unknown) =>
      applyAnswer(requester, token, (state) => ({
        ...state,
        error: messageOf(failure),
        failedSource: source,
        pending: null,
      })),
  );
}

/**
 * Marks a listing request as running and sends it.
 *
 * @param requester the request tracking, the setter and the target
 * @param source the place of the target, or a folder the user picks
 */
function beginRequest(requester: Requester, source: ListingSource): void {
  requester.setState((current) => ({
    ...(current.key === requester.key ? current : freshState(requester.key)),
    pending: source,
    error: null,
    failedSource: null,
  }));
  sendRequest(requester, source);
}

/**
 * Loads the listing of the target while `open`, and keeps the chosen backup. Answers that arrive after a newer
 * request, a target change or a close are dropped.
 *
 * @param open whether the dialog is shown
 * @param target the workspace by id or folder
 * @returns the listing state and its actions
 */
export function useBackupListing(open: boolean, target: RestoreTarget): BackupListingControl {
  const key = targetKey(target);
  const [stored, setState] = useState<ListingState>(() => freshState(key));
  const latest = useRef(0);
  const state = stored.key === key ? stored : freshState(key);
  const id = 'id' in target ? target.id : null;
  const rootPath = 'rootPath' in target ? target.rootPath : '';

  useEffect(() => {
    if (!open) return;
    const requestTarget: RestoreTarget = id === null ? { rootPath } : { id };
    sendRequest({ latest, setState, target: requestTarget, key: targetKey(requestTarget) }, 'default');
    return () => {
      latest.current += 1;
    };
  }, [open, id, rootPath]);

  const requester: Requester = { latest, setState, target, key };
  return {
    listing: state.listing,
    selectedId: state.selectedId,
    stale: state.stale,
    error: state.error,
    retryable: state.failedSource === 'default',
    loading: state.pending !== null,
    select: (selectedId) => setState((current) => ({ ...current, selectedId })),
    reload: () => beginRequest(requester, 'default'),
    pick: () => beginRequest(requester, 'picked'),
    refused: () =>
      state.source === 'default'
        ? beginRequest(requester, 'default')
        : setState((current) => ({ ...current, stale: true })),
  };
}
