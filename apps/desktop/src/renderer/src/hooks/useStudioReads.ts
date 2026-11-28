import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Generation } from '@assetforge/contracts';
import { call } from '../api';
import { messageOf, newestFirst } from '../studio-actions';
import { tileState } from '../studio-state';

/** What the studio reads work with. */
export interface StudioReadsInput {
  fileId: string;
  results: Generation[] | null;
  selectedId: string | null;
  /** Moves whenever the jobs context saw a change. */
  changeToken: number;
  /** A start of this source sent through the session runs. */
  sessionStarting: boolean;
  setResults(results: Generation[]): void;
  setUpscales(upscales: Generation[]): void;
  setRecent(prompts: string[]): void;
  setLoadError(message: string | null): void;
}

/** The reads of the studio and the selected result. */
export interface StudioReads {
  /** True once the studio unmounted. */
  disposed: MutableRefObject<boolean>;
  loadResults(): Promise<void>;
  loadUpscales(): Promise<void>;
  loadRecent(): Promise<void>;
  /** The selected result while it is ready; null otherwise. */
  selected: Generation | null;
  /** The file of the selected result; null for none. */
  selectedFileId: string | null;
}

/**
 * Reads the results of the source, the upscales of the selected result and the recent prompts, again
 * whenever the jobs context's `changeToken` moves.
 *
 * @param input the source, the selection and the setters
 * @returns the reads, the unmount flag and the selected result
 */
export function useStudioReads(input: StudioReadsInput): StudioReads {
  const { fileId, results, selectedId, changeToken, sessionStarting, setResults, setUpscales, setRecent, setLoadError } =
    input;
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  // Only the newest read may set the results.
  const readSeq = useRef(0);
  const loadResults = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const answer = await call('generations:forFile', { fileId });
      if (disposed.current || seq !== readSeq.current) return;
      setResults([...answer.results].sort(newestFirst));
      setLoadError(null);
    } catch (error) {
      if (!disposed.current && seq === readSeq.current) setLoadError(messageOf(error));
    }
    // The setters are stable state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  const selected = results?.find((generation) => generation.id === selectedId && tileState(generation) === 'ready') ?? null;
  const selectedFileId = selected?.outputs[0]?.fileId ?? null;

  // The upscales of the selected result, one level deep; only the newest read may set them.
  const upscaleSeq = useRef(0);
  const loadUpscales = useCallback(async () => {
    const seq = ++upscaleSeq.current;
    if (selectedFileId === null) {
      setUpscales([]);
      return;
    }
    try {
      const answer = await call('generations:forFile', { fileId: selectedFileId });
      if (disposed.current || seq !== upscaleSeq.current) return;
      setUpscales(answer.results.filter((generation) => generation.kind === 'upscale').sort(newestFirst));
      setLoadError(null);
    } catch (error) {
      if (!disposed.current && seq === upscaleSeq.current) setLoadError(messageOf(error));
    }
    // The setters are stable state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFileId]);

  const loadRecent = useCallback(async () => {
    try {
      const answer = await call('generations:recentPrompts', {});
      if (!disposed.current) setRecent(answer.prompts);
    } catch {
      // Recent prompts are a convenience; without them the select is left out.
    }
    // The setter is a stable state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadResults();
  }, [loadResults, changeToken]);

  useEffect(() => {
    void loadUpscales();
  }, [loadUpscales, changeToken]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // A start sent before a raise ends after this instance read its results: they are read again.
  const wasStarting = useRef(sessionStarting);
  useEffect(() => {
    if (wasStarting.current && !sessionStarting) {
      void loadResults();
      void loadRecent();
    }
    wasStarting.current = sessionStarting;
  }, [sessionStarting, loadResults, loadRecent]);

  return { disposed, loadResults, loadUpscales, loadRecent, selected, selectedFileId };
}
