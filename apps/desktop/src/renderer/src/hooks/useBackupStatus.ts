import { useContext, useEffect, useState } from 'react';
import type { BackupStatus } from '@assetforge/contracts';
import { call } from '../api';
import { BackupStateContext, backupStateSignal } from './useBackupState';

/** What `useBackupStatus` offers. */
export interface BackupStatusControl {
  /** The latest status, or null before the first answer. */
  status: BackupStatus | null;
  /** The last load failed. */
  failed: boolean;
  /** Shows a newer status, the answer of an action. */
  show(status: BackupStatus): void;
  /** Loads again after a failure. */
  retry(): void;
}

/**
 * Loads the backup status on mount, on every retry, and whenever the backup state the shell polls shows a backup
 * starting or ending or a new last attempt; an answer that a newer load superseded is dropped.
 *
 * @returns the status, whether the last load failed, the setter and the retry
 */
export function useBackupStatus(): BackupStatusControl {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signal = backupStateSignal(useContext(BackupStateContext));
  useEffect(() => {
    let active = true;
    call('backup:status', {}).then(
      (value) => {
        if (!active) return;
        setFailed(false);
        setStatus(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, signal]);
  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };
  return { status, failed, show: setStatus, retry };
}
