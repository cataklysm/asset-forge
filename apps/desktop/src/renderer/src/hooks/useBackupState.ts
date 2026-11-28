import { useEffect, useState } from 'react';
import { BACKUP_MESSAGES, type BackupAttempt, type BackupState } from '@assetforge/contracts';
import { call } from '../api';
import { startPolling } from '../poller';

/** The pause between the answer of one `backup:state` poll and the next request. */
export const BACKUP_STATE_POLL_MS = 5000;

/**
 * Asks for the backup state; a background call that never raises the storage banner.
 *
 * @returns the state of the backup of the open workspace
 */
function requestState(): Promise<BackupState> {
  return call('backup:state', {}, { reportUnreachable: false });
}

/** One running poll of the backup state. */
interface StatePoll {
  /** Whether the effect was cleaned up. */
  stopped: boolean;
  /** Stops the poller once it runs. */
  stop: (() => void) | null;
}

/**
 * Asks once at once, then every `BACKUP_STATE_POLL_MS` after the previous answer, until stopped.
 *
 * @param poll the poll, which the cleanup stops
 * @param onValue receives every answer; a failed request keeps the last value
 */
function startStatePoll(poll: StatePoll, onValue: (state: BackupState) => void): void {
  requestState()
    .then(
      (state) => {
        if (!poll.stopped) onValue(state);
      },
      () => {},
    )
    .finally(() => {
      if (!poll.stopped) poll.stop = startPolling(requestState, onValue, BACKUP_STATE_POLL_MS);
    });
}

/**
 * Polls the backup state while `active`, one request at a time; a failed poll keeps the last value.
 *
 * @param active whether to poll
 * @returns the last state, or null before the first answer
 */
export function useBackupState(active: boolean): BackupState | null {
  const [state, setState] = useState<BackupState | null>(null);
  useEffect(() => {
    if (!active) return;
    const poll: StatePoll = { stopped: false, stop: null };
    startStatePoll(poll, setState);
    return () => {
      poll.stopped = true;
      poll.stop?.();
    };
  }, [active]);
  return state;
}

/**
 * The reason of a failed attempt: its fixed message, else the message of its code, else the general one.
 *
 * @param attempt the failed attempt
 * @returns the message
 */
export function failureMessage(attempt: BackupAttempt): string {
  return (
    attempt.message ?? (attempt.code === null ? null : BACKUP_MESSAGES[attempt.code]) ?? BACKUP_MESSAGES.backup_failed
  );
}

/**
 * The failure the banner shows: the last attempt of the given workspace when it failed.
 *
 * @param state the polled state, or null
 * @param workspaceId the open workspace
 * @returns the reason, or null when there is nothing to show
 */
export function backupFailureOf(state: BackupState | null, workspaceId: string): string | null {
  if (state === null || state.workspaceId !== workspaceId || state.last === null || state.last.ok) return null;
  return failureMessage(state.last);
}
