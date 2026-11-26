import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisPrompt, AnalysisPromptPurpose, SaveAnalysisPrompt } from '@assetforge/contracts';
import { call } from './api';

type LastUsed = { tagging: string | null; imagePrompt: string | null };

export interface AnalysisPromptsState {
  /** Null until the first answer, or when loading failed. */
  prompts: AnalysisPrompt[] | null;
  lastUsed: LastUsed;
  loading: boolean;
  /** True when the last load failed. */
  failed: boolean;
  reload(): Promise<void>;
  save(input: SaveAnalysisPrompt): Promise<AnalysisPrompt>;
  remove(id: string): Promise<void>;
  reset(id: string): Promise<AnalysisPrompt>;
  /** Records locally what the main process stored after a start, so the next dialog preselects it. */
  noteUsed(purpose: AnalysisPromptPurpose, id: string): void;
}

const NONE_USED: LastUsed = { tagging: null, imagePrompt: null };

const EMPTY: AnalysisPromptsState = {
  prompts: null,
  lastUsed: NONE_USED,
  loading: false,
  failed: false,
  reload: async () => {},
  save: () => Promise.reject(new Error('No analysis prompts')),
  remove: () => Promise.reject(new Error('No analysis prompts')),
  reset: () => Promise.reject(new Error('No analysis prompts')),
  noteUsed: () => {},
};

const AnalysisPromptsContext = createContext<AnalysisPromptsState>(EMPTY);

const lastUsedKey = (purpose: AnalysisPromptPurpose) => (purpose === 'tagging' ? 'tagging' : 'imagePrompt');

/** Puts `prompt` in place of the one with its id, or appends it. */
function upsert(list: AnalysisPrompt[] | null, prompt: AnalysisPrompt): AnalysisPrompt[] | null {
  if (list === null) return list;
  return list.some((p) => p.id === prompt.id) ? list.map((p) => (p.id === prompt.id ? prompt : p)) : [...list, prompt];
}

/**
 * The analysis prompts of the app and the ones used last. Loads once on mount; save, remove and
 * reset take the answer into the list without listing again. It does not poll.
 */
export function AnalysisPromptsProvider({ children }: { children: ReactNode }) {
  const [prompts, setPrompts] = useState<AnalysisPrompt[] | null>(null);
  const [lastUsed, setLastUsed] = useState<LastUsed>(NONE_USED);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const disposed = useRef(false);
  // Only the newest reload may take its answer; an older one arriving later is dropped.
  const reloadRequest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++reloadRequest.current;
    setLoading(true);
    try {
      const list = await call('analysisPrompts:list', {});
      if (disposed.current || request !== reloadRequest.current) return;
      setPrompts(list.prompts);
      setLastUsed(list.lastUsed);
      setFailed(false);
    } catch (e) {
      if (request !== reloadRequest.current) return;
      if (!disposed.current) {
        setPrompts(null);
        setFailed(true);
      }
      throw e;
    } finally {
      if (!disposed.current && request === reloadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    // A failed first load leaves `prompts` null and sets `failed`; the screens offer a retry.
    void reload().catch(() => {});
    return () => {
      disposed.current = true;
    };
  }, [reload]);

  const save = useCallback(async (input: SaveAnalysisPrompt) => {
    const prompt = await call('analysisPrompts:save', input);
    if (!disposed.current) setPrompts((list) => upsert(list, prompt));
    return prompt;
  }, []);

  const remove = useCallback(async (id: string) => {
    await call('analysisPrompts:delete', { id });
    if (disposed.current) return;
    setPrompts((list) => (list === null ? list : list.filter((p) => p.id !== id)));
    setLastUsed((used) => ({
      tagging: used.tagging === id ? null : used.tagging,
      imagePrompt: used.imagePrompt === id ? null : used.imagePrompt,
    }));
  }, []);

  const reset = useCallback(async (id: string) => {
    const prompt = await call('analysisPrompts:reset', { id });
    if (!disposed.current) setPrompts((list) => upsert(list, prompt));
    return prompt;
  }, []);

  const noteUsed = useCallback((purpose: AnalysisPromptPurpose, id: string) => {
    setLastUsed((used) => ({ ...used, [lastUsedKey(purpose)]: id }));
  }, []);

  const value = useMemo<AnalysisPromptsState>(
    () => ({ prompts, lastUsed, loading, failed, reload, save, remove, reset, noteUsed }),
    [prompts, lastUsed, loading, failed, reload, save, remove, reset, noteUsed],
  );

  return <AnalysisPromptsContext.Provider value={value}>{children}</AnalysisPromptsContext.Provider>;
}

/** The state of the surrounding `AnalysisPromptsProvider`; outside one the empty state. */
export function useAnalysisPrompts(): AnalysisPromptsState {
  return useContext(AnalysisPromptsContext);
}

/** The prompt a dialog preselects: the one used last when it still exists, otherwise the first of the purpose; null when there is none or nothing is loaded. */
export function defaultPromptId(
  state: Pick<AnalysisPromptsState, 'prompts' | 'lastUsed'>,
  purpose: AnalysisPromptPurpose,
): string | null {
  if (state.prompts === null) return null;
  const own = state.prompts.filter((p) => p.purpose === purpose);
  const last = state.lastUsed[lastUsedKey(purpose)];
  return own.find((p) => p.id === last)?.id ?? own[0]?.id ?? null;
}
