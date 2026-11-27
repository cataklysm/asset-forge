import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportProgress } from '@assetforge/contracts';
import { call } from './api';

export const IMPORT_POLL_MS = 500;
/** While an import runs, its screen reloads the file list at most this often. */
export const IMPORT_RELOAD_MS = 3000;

/**
 * The share of a running import that is done, between 0 and 1: the finished items plus the
 * written part of the current one (0 when its size is unknown or 0, at most 1), over the total.
 */
export function importProgressValue(progress: ImportProgress): number {
  if (progress.total <= 0) return 0;
  const size = progress.currentSize;
  const fraction = size === null || size <= 0 ? 0 : Math.min(1, progress.currentBytes / size);
  return Math.min(1, Math.max(0, (progress.done + fraction) / progress.total));
}

export interface ImportProgressState {
  /** The last known progress; null while inactive and until the first answer that holds one. */
  progress: ImportProgress | null;
  /** Asks the main process to stop the running import after its current item. */
  cancel(): void;
  /** Whether a cancel was requested (and accepted) during the import that runs or ran last. */
  cancelRequested: boolean;
}

/**
 * While `active` (the screen's `files:import` call is pending), asks `files:importProgress` every
 * `IMPORT_POLL_MS`, one request at a time. A failed request keeps the last value and the next tick
 * asks again; inactive resets the progress to null. `cancelRequested` resets when an import starts.
 */
export function useImportProgress(active: boolean): ImportProgressState {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  // Which activation a cancel belongs to; an answer that arrives after it ended is ignored.
  const run = useRef({ active, id: 0 });
  // Reset while rendering, so that the first render of a new import never shows the last one's cancel.
  const [seenActive, setSeenActive] = useState(active);
  if (seenActive !== active) {
    setSeenActive(active);
    if (active) setCancelRequested(false);
  }

  useEffect(() => {
    run.current = { active, id: run.current.id + 1 };
    if (!active) {
      setProgress(null);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function poll() {
      timer = null;
      call('files:importProgress', {})
        .then(
          (next) => {
            if (!disposed) setProgress(next);
          },
          // The last value stays; the next tick asks again.
          () => {},
        )
        .finally(() => {
          if (!disposed) timer = setTimeout(poll, IMPORT_POLL_MS);
        });
    }

    timer = setTimeout(poll, IMPORT_POLL_MS);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active]);

  const cancel = useCallback(() => {
    if (!run.current.active) return;
    const id = run.current.id;
    setCancelRequested(true);
    setProgress((current) => (current === null ? null : { ...current, cancelling: true }));
    const refused = () => {
      if (run.current.id === id) setCancelRequested(false);
    };
    call('files:cancelImport', {}).then(({ cancelling }) => {
      if (!cancelling) refused();
    }, refused);
  }, []);

  // Inactive shows no progress at once, before the effect has cleared the last value.
  return { progress: active ? progress : null, cancel, cancelRequested };
}

/**
 * While `active`, calls `reload` every `IMPORT_RELOAD_MS` when `done` of the progress has changed
 * since the last reload (the start of the import counts as a reload at 0).
 */
export function useImportReload(active: boolean, progress: ImportProgress | null, reload: () => void): void {
  const latest = useRef({ done: progress?.done ?? null, reload });
  latest.current = { done: progress?.done ?? null, reload };

  useEffect(() => {
    if (!active) return;
    let reloadedAt = 0;
    const timer = setInterval(() => {
      const { done, reload: run } = latest.current;
      if (done === null || done === reloadedAt) return;
      reloadedAt = done;
      run();
    }, IMPORT_RELOAD_MS);
    return () => clearInterval(timer);
  }, [active]);
}
