import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { AnalysisPrompt, AnalysisPromptPurpose, SaveAnalysisPrompt } from '@assetforge/contracts';
import { ApiError, call, describeError } from './api';

/** The prompt used last per purpose. */
type LastUsed = { tagging: string | null; imagePrompt: string | null };

/** What the analysis prompts context offers. */
export interface AnalysisPromptsState {
  /** Null until the first answer, or when loading failed. */
  prompts: AnalysisPrompt[] | null;
  lastUsed: LastUsed;
  loading: boolean;
  /** True when the last load failed. */
  failed: boolean;
  /** Lists the prompts again; rejects when they cannot be read. */
  reload(): Promise<void>;
  /** Saves and takes the answer into the list. */
  save(input: SaveAnalysisPrompt): Promise<AnalysisPrompt>;
  /** Deletes and drops the prompt from the list and from the ones used last. */
  remove(id: string): Promise<void>;
  /** Resets to the built-in content of the purpose and takes the answer into the list. */
  reset(id: string): Promise<AnalysisPrompt>;
  /** Records locally what the main process stored after a start, so the next dialog preselects it. */
  noteUsed(purpose: AnalysisPromptPurpose, id: string): void;
}

/** No prompt used last. */
const NONE_USED: LastUsed = { tagging: null, imagePrompt: null };

/** The state outside a provider. */
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

/** The analysis prompts of the app. */
const AnalysisPromptsContext = createContext<AnalysisPromptsState>(EMPTY);

/** What a reload reads and writes. */
interface PromptsLoading {
  disposed: MutableRefObject<boolean>;
  /** Only the newest reload may take its answer. */
  request: MutableRefObject<number>;
  /** The newest reload that has ended; a reload is under way while it differs from `request`. */
  settled: MutableRefObject<number>;
  setPrompts(prompts: AnalysisPrompt[] | null): void;
  setLastUsed(lastUsed: LastUsed): void;
  setLoading(loading: boolean): void;
  setFailed(failed: boolean): void;
}

/**
 * The key of `purpose` in `LastUsed`.
 *
 * @param purpose the purpose
 * @returns the key
 */
const lastUsedKey = (purpose: AnalysisPromptPurpose) => (purpose === 'tagging' ? 'tagging' : 'imagePrompt');

/**
 * Puts `prompt` in place of the one with its id, or appends it.
 *
 * @param list the held list; null while none is held
 * @param prompt the answered prompt
 * @returns the new list
 */
function upsert(list: AnalysisPrompt[] | null, prompt: AnalysisPrompt): AnalysisPrompt[] | null {
  if (list === null) return list;
  return list.some((entry) => entry.id === prompt.id)
    ? list.map((entry) => (entry.id === prompt.id ? prompt : entry))
    : [...list, prompt];
}

/**
 * Lists the prompts again; an older reload arriving later is dropped.
 *
 * @param loading the refs and setters
 * @returns resolves once the answer is taken; rejects when the list cannot be read
 */
async function reloadPrompts(loading: PromptsLoading): Promise<void> {
  const request = ++loading.request.current;
  loading.setLoading(true);
  try {
    const list = await call('analysisPrompts:list', {});
    if (loading.disposed.current || request !== loading.request.current) return;
    loading.setPrompts(list.prompts);
    loading.setLastUsed(list.lastUsed);
    loading.setFailed(false);
  } catch (error) {
    if (request !== loading.request.current) return;
    if (!loading.disposed.current) {
      loading.setPrompts(null);
      loading.setFailed(true);
    }
    throw error;
  } finally {
    if (request === loading.request.current) loading.settled.current = request;
    if (!loading.disposed.current && request === loading.request.current) loading.setLoading(false);
  }
}

/**
 * The analysis prompts of the app and the ones used last. Loads once on mount; save, remove and
 * reset take the answer into the list and list again only while a reload is under way (its answer
 * may predate the change). It does not poll.
 *
 * @param props.children the tree that reads the prompts
 */
export function AnalysisPromptsProvider({ children }: { children: ReactNode }) {
  const [prompts, setPrompts] = useState<AnalysisPrompt[] | null>(null);
  const [lastUsed, setLastUsed] = useState<LastUsed>(NONE_USED);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const disposed = useRef(false);
  // Only the newest reload may take its answer; an older one arriving later is dropped.
  const reloadRequest = useRef(0);
  const reloadSettled = useRef(0);

  const reload = useCallback(
    () =>
      reloadPrompts({
        disposed,
        request: reloadRequest,
        settled: reloadSettled,
        setPrompts,
        setLastUsed,
        setLoading,
        setFailed,
      }),
    [],
  );

  // A reload under way may answer a list read before a change: list again after the change, so
  // the newer reload supersedes the older one.
  const relistIfLoading = useCallback(() => {
    if (disposed.current || reloadSettled.current === reloadRequest.current) return;
    void reload().catch(() => {});
  }, [reload]);

  useEffect(() => {
    disposed.current = false;
    // A failed first load leaves `prompts` null and sets `failed`; the screens offer a retry.
    void reload().catch(() => {});
    return () => {
      disposed.current = true;
    };
  }, [reload]);

  const save = useCallback(
    async (input: SaveAnalysisPrompt) => {
      const prompt = await call('analysisPrompts:save', input);
      if (!disposed.current) setPrompts((list) => upsert(list, prompt));
      relistIfLoading();
      return prompt;
    },
    [relistIfLoading],
  );

  const remove = useCallback(
    async (id: string) => {
      await call('analysisPrompts:delete', { id });
      if (disposed.current) return;
      setPrompts((list) => (list === null ? list : list.filter((entry) => entry.id !== id)));
      setLastUsed((used) => ({
        tagging: used.tagging === id ? null : used.tagging,
        imagePrompt: used.imagePrompt === id ? null : used.imagePrompt,
      }));
      relistIfLoading();
    },
    [relistIfLoading],
  );

  const reset = useCallback(
    async (id: string) => {
      const prompt = await call('analysisPrompts:reset', { id });
      if (!disposed.current) setPrompts((list) => upsert(list, prompt));
      relistIfLoading();
      return prompt;
    },
    [relistIfLoading],
  );

  const noteUsed = useCallback((purpose: AnalysisPromptPurpose, id: string) => {
    setLastUsed((used) => ({ ...used, [lastUsedKey(purpose)]: id }));
  }, []);

  const value = useMemo<AnalysisPromptsState>(
    () => ({ prompts, lastUsed, loading, failed, reload, save, remove, reset, noteUsed }),
    [prompts, lastUsed, loading, failed, reload, save, remove, reset, noteUsed],
  );

  return <AnalysisPromptsContext.Provider value={value}>{children}</AnalysisPromptsContext.Provider>;
}

/**
 * The state of the surrounding `AnalysisPromptsProvider`.
 *
 * @returns the state; outside a provider the empty state
 */
export function useAnalysisPrompts(): AnalysisPromptsState {
  return useContext(AnalysisPromptsContext);
}

/**
 * The prompt a dialog preselects: the one used last when it still exists, otherwise the first of the purpose.
 *
 * @param state the prompts and the ones used last
 * @param purpose the purpose of the dialog
 * @returns the prompt; null when there is none or nothing is loaded
 */
export function defaultPromptId(
  state: Pick<AnalysisPromptsState, 'prompts' | 'lastUsed'>,
  purpose: AnalysisPromptPurpose,
): string | null {
  if (state.prompts === null) return null;
  const own = state.prompts.filter((prompt) => prompt.purpose === purpose);
  const last = state.lastUsed[lastUsedKey(purpose)];
  return own.find((prompt) => prompt.id === last)?.id ?? own[0]?.id ?? null;
}

/** The forwarded message of a start that names a provider entry deleted meanwhile. */
const PROVIDER_MISSING = 'This provider does not exist';

/** The forwarded message of a start that names an analysis prompt deleted meanwhile. */
const PROMPT_MISSING = 'The analysis prompt does not exist';

/**
 * The text an analysis start shows for what it threw: a provider entry or a prompt deleted meanwhile
 * keeps the fixed message the main process forwards, so the owner sees which choice is gone; anything
 * else gets the text of its code.
 *
 * @param error what the start threw
 * @returns the text
 */
export function startErrorMessage(error: unknown): string {
  const missingChoice =
    error instanceof ApiError &&
    error.code === 'not_found' &&
    (error.message === PROVIDER_MISSING || error.message === PROMPT_MISSING);
  return missingChoice ? error.message : describeError(error);
}

/**
 * After a start refused with `not_found`: the provider entry or the prompt may have been deleted
 * meanwhile. A missing provider reloads the providers, so the provider choice falls back, and keeps
 * the prompt choice; anything else reloads the prompts and the dialog drops its prompt choice to fall
 * back to a prompt that exists. Any other error changes nothing.
 *
 * @param error what the start threw
 * @param prompts the reload of the analysis prompts
 * @param providers the reload of the provider entries
 * @param dropChoice drops the dialog's prompt choice; it checks itself whether the dialog still wants it
 */
export function recoverMissingChoice(
  error: unknown,
  prompts: Pick<AnalysisPromptsState, 'reload'>,
  providers: { reload(): Promise<void> },
  dropChoice: () => void,
): void {
  if (!(error instanceof ApiError) || error.code !== 'not_found') return;
  if (error.message === PROVIDER_MISSING) {
    void providers.reload().catch(() => {});
    return;
  }
  void prompts.reload().catch(() => {});
  dropChoice();
}

/**
 * The prompt a dialog uses: the user's choice while the list holds it for the purpose, otherwise
 * (no choice, or the chosen prompt vanished through a reload) the one `defaultPromptId` preselects.
 *
 * @param state the prompts and the ones used last
 * @param purpose the purpose of the dialog
 * @param chosen the user's choice; null when there is none
 * @returns the prompt; null when there is none or nothing is loaded
 */
export function effectivePromptId(
  state: Pick<AnalysisPromptsState, 'prompts' | 'lastUsed'>,
  purpose: AnalysisPromptPurpose,
  chosen: string | null,
): string | null {
  if (chosen === null || state.prompts === null) return defaultPromptId(state, purpose);
  const held = state.prompts.some((prompt) => prompt.id === chosen && prompt.purpose === purpose);
  return held ? chosen : defaultPromptId(state, purpose);
}
