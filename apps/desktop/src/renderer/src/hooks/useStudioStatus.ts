import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Generation } from '@assetforge/contracts';
import type { StudioSession } from '../studio-session';
import { freshFields } from '../studio-fields';
import type { StudioFieldsState } from './useStudioFields';

/** The results, the selection, the messages and the busy flags of the studio. */
export interface StudioStatus {
  /** The results of the source, newest first; null while they are read. */
  results: Generation[] | null;
  setResults(results: Generation[]): void;
  /** The upscales of the selected result, newest first. */
  upscales: Generation[];
  setUpscales(upscales: Generation[]): void;
  /** The recent prompts. */
  recent: string[];
  setRecent(prompts: string[]): void;
  selectedId: string | null;
  setSelectedId(id: string | null): void;
  /** Why the last start failed; kept in the session too. */
  startError: string | null;
  setStartError(message: string | null): void;
  actionError: string | null;
  setActionError(message: string | null): void;
  loadError: string | null;
  setLoadError: Dispatch<SetStateAction<string | null>>;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  /** The source file the state belongs to. */
  shownFileId: string;
  /** A result action runs. */
  busy: boolean;
  setBusy(busy: boolean): void;
  /** An edit start of this instance runs. */
  starting: boolean;
  setStarting(starting: boolean): void;
}

/**
 * The state of the studio beside its form. Another source image starts from a fresh form and its
 * own results; safe mode stays as remembered.
 *
 * @param fileId the source file
 * @param session the studio session
 * @param form the form fields, reset with the rest for another source
 * @returns the state and its setters
 */
export function useStudioStatus(fileId: string, session: StudioSession, form: StudioFieldsState): StudioStatus {
  const [results, setResults] = useState<Generation[] | null>(null);
  const [upscales, setUpscales] = useState<Generation[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Also kept in the session, so that a start failing after the studio was closed shows when it opens again
  // (outside a provider the session keeps nothing and this instance's own copy shows it).
  const [ownStartError, setOwnStartError] = useState<string | null>(null);
  const startError = session.startError(fileId) ?? ownStartError;
  const setStartError = (message: string | null) => {
    setOwnStartError(message);
    session.setStartError(fileId, message);
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Another source image starts from a fresh form and its own results; safe mode stays as remembered.
  const [shownFileId, setShownFileId] = useState(fileId);
  if (shownFileId !== fileId) {
    setShownFileId(fileId);
    form.setFields((current) => freshFields(current.safeMode));
    form.setPicking(false);
    form.setSaving(false);
    form.setPendingModel(null);
    setResults(null);
    setUpscales([]);
    setSelectedId(null);
    setOwnStartError(null);
    setActionError(null);
    setLoadError(null);
  }
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  return {
    results,
    setResults,
    upscales,
    setUpscales,
    recent,
    setRecent,
    selectedId,
    setSelectedId,
    startError,
    setStartError,
    actionError,
    setActionError,
    loadError,
    setLoadError,
    promptRef,
    shownFileId,
    busy,
    setBusy,
    starting,
    setStarting,
  };
}
