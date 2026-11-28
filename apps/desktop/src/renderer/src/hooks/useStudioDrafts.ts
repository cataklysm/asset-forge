import { useCallback, useRef, useState } from 'react';
import type { StudioForm } from '../studio-state';

/** What `useStudioDrafts` offers. */
export interface StudioDrafts {
  /** The studio form kept for `fileId`; undefined for another file and after the studio was closed. */
  draft(fileId: string): StudioForm | undefined;
  /** Keeps the studio form of `fileId` until the studio closes or shows another file. */
  keepDraft(fileId: string, form: StudioForm): void;
  /** Why the last edit start for the source `fileId` failed; null when it did not or the studio was closed since. */
  startError(fileId: string): string | null;
  /** Sets (or with null clears) the start error of `fileId`; it outlives a raise and goes on close. */
  setStartError(fileId: string, message: string | null): void;
  /** Marks the studio open, so start errors are kept again. */
  opened(): void;
  /** Marks the studio closed and drops the kept form and every start error. */
  forget(): void;
}

/**
 * The map of start errors after setting (or with null clearing) the one of `fileId`.
 *
 * @param current the errors so far
 * @param fileId the source file
 * @param message the error; null clears it
 * @returns the new map, or `current` itself when nothing changed
 */
function withStartError(
  current: ReadonlyMap<string, string>,
  fileId: string,
  message: string | null,
): ReadonlyMap<string, string> {
  if ((current.get(fileId) ?? null) === message) return current;
  const next = new Map(current);
  if (message === null) next.delete(fileId);
  else next.set(fileId, message);
  return next;
}

/**
 * What outlives one instance of the studio dialog while the studio stays open: the form of the shown
 * source and the last start error per source.
 *
 * @returns the drafts, the start errors and the open and close marks
 */
export function useStudioDrafts(): StudioDrafts {
  // Whether the studio is open: a start answering after a close (which drops every start error) shows nothing later.
  const studioOpen = useRef(false);
  // The form of the studio's source, so that a raise (a remount) shows it as it was; dropped on close.
  const kept = useRef<{ fileId: string; form: StudioForm } | null>(null);
  const draft = useCallback((fileId: string) => (kept.current?.fileId === fileId ? kept.current.form : undefined), []);
  const keepDraft = useCallback((fileId: string, form: StudioForm) => {
    kept.current = { fileId, form };
  }, []);
  // The last start error per source, so that a start failing after a raise shows in the new instance.
  const [startErrors, setStartErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const startError = useCallback((fileId: string) => startErrors.get(fileId) ?? null, [startErrors]);
  const setStartError = useCallback((fileId: string, message: string | null) => {
    if (message !== null && !studioOpen.current) return;
    setStartErrors((current) => withStartError(current, fileId, message));
  }, []);
  const opened = useCallback(() => {
    studioOpen.current = true;
  }, []);
  const forget = useCallback(() => {
    kept.current = null;
    studioOpen.current = false;
    setStartErrors(new Map());
  }, []);
  return { draft, keepDraft, startError, setStartError, opened, forget };
}
