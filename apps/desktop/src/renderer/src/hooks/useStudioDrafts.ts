import { useCallback, useRef, useState } from 'react';
import type { StudioForm } from '../studio-state';

/** What `useStudioDrafts` offers. */
export interface StudioDrafts {
  /** The studio form kept for `fileId`; undefined for another file and after the studio was closed. */
  draft(fileId: string): StudioForm | undefined;
  /** Keeps the studio form of `fileId` until the studio closes or shows another file. */
  keepDraft(fileId: string, form: StudioForm): void;
  /** Why the last edit start for the source `fileId` failed; null when it did not or the studio was closed since it failed. */
  startError(fileId: string): string | null;
  /** Sets (or with null clears) the start error of `fileId`; it goes when the studio closes, and a start failing after that keeps it until the next close. */
  setStartError(fileId: string, message: string | null): void;
  /** Drops the kept form and every start error so far, when the studio closes. */
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
 * What the studio session keeps beside the mounted dialog: the form of the shown source, dropped on
 * close, and the last start error per source. A start that fails after the studio was closed keeps
 * its error, so that the studio of that source shows it when it opens again.
 *
 * @returns the drafts, the start errors and the close mark
 */
export function useStudioDrafts(): StudioDrafts {
  // The form of the studio's source, read when the studio shows the source again; dropped on close.
  const kept = useRef<{ fileId: string; form: StudioForm } | null>(null);
  const draft = useCallback((fileId: string) => (kept.current?.fileId === fileId ? kept.current.form : undefined), []);
  const keepDraft = useCallback((fileId: string, form: StudioForm) => {
    kept.current = { fileId, form };
  }, []);
  // The last start error per source, also of a start that failed after the studio was closed.
  const [startErrors, setStartErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const startError = useCallback((fileId: string) => startErrors.get(fileId) ?? null, [startErrors]);
  const setStartError = useCallback((fileId: string, message: string | null) => {
    setStartErrors((current) => withStartError(current, fileId, message));
  }, []);
  const forget = useCallback(() => {
    kept.current = null;
    setStartErrors(new Map());
  }, []);
  return { draft, keepDraft, startError, setStartError, forget };
}
