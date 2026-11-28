import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type ListImageModelsResult,
  type ListModelsResult,
  purposeOf,
  type ProviderPurpose,
  type ProviderList,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import { call } from './api';
import { onlyListed, upsert, without, withoutEntry } from './provider-list';
import {
  loadEntryModels,
  purposeOfEntry,
  reloadList,
  type ImageModels,
  type ModelsFailure,
  type VisionModels,
} from './provider-loading';

/** The state of one provider entry as the selects and the settings show it. */
export type ProviderStatus =
  'checking' | 'ready' | 'unreachable' | 'unauthorized' | 'no_vision_model' | 'no_edit_model' | 'error';

/** What the provider context offers. */
export interface ProvidersState {
  /** Null until the first answer; a later failed reload keeps the list held. */
  list: ProviderList | null;
  /** True while the list loads. */
  loading: boolean;
  /** True when loading failed and no list is held (not the same as "no provider"). */
  failed: boolean;
  /** True when the last reload failed while a list is held; the held list stays usable. */
  reloadFailed: boolean;
  /** The model list answer per vision entry (Ollama or OpenAI-compatible); undefined before the first answer and while a request runs. */
  models: Readonly<Record<string, ListModelsResult | undefined>>;
  /** The edit model list answer per image entry (Venice); `checking` while a request runs, absent before the first. */
  imageModels: Readonly<Record<string, ListImageModelsResult | 'checking'>>;
  /** Loads the list again, then the model list of every entry; rejects when the list cannot be read. */
  reload(): Promise<void>;
  /**
   * Asks for the models of one entry by its purpose: vision models for a vision entry, edit models for
   * an image entry; `refresh` asks the provider instead of the main process cache. Never rejects.
   */
  loadModels(id: string, refresh?: boolean): Promise<void>;
  /** Asks every entry with `refresh: true`, in parallel. */
  checkAll(): void;
  /** Saves, takes the returned entry into the list and loads its models. */
  save(input: SaveProvider): Promise<ProviderView>;
  /** Deletes the entry and drops it with its model lists. */
  remove(id: string): Promise<void>;
  /**
   * Records locally what the main process stored after an accepted analysis or generation start, as the
   * entry used last of its purpose, so the next dialog preselects it.
   */
  noteUsed(id: string): void;
}

/** The provider state outside a provider. */
const EMPTY: ProvidersState = {
  list: null,
  loading: false,
  failed: false,
  reloadFailed: false,
  models: {},
  imageModels: {},
  reload: async () => {},
  loadModels: async () => {},
  checkAll: () => {},
  save: () => Promise.reject(new Error('No provider settings')),
  remove: () => Promise.reject(new Error('No provider settings')),
  noteUsed: () => {},
};

/** The provider entries and their model lists. */
const ProvidersContext = createContext<ProvidersState>(EMPTY);

/**
 * The provider entries of the app and the model list of each. Loads the list once on mount and the
 * models of every entry in parallel; an answer for an entry is taken only when it is the newest
 * request for that entry. It does not poll.
 *
 * @param props.children the tree that reads the provider state
 */
export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ProviderList | null>(null);
  const [models, setModels] = useState<VisionModels>({});
  const [imageModels, setImageModels] = useState<ImageModels>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const disposed = useRef(false);
  const listRef = useRef<ProviderList | null>(null);
  // Per entry: only the newest model request may set its answer.
  const modelRequests = useRef(new Map<string, number>());

  const takeList = useCallback((next: ProviderList | null) => {
    listRef.current = next;
    setList(next);
    if (next === null) return;
    // Answers of entries that are no longer listed (deleted elsewhere) go, and a late one is dropped.
    const ids = new Set(next.providers.map((entry) => entry.id));
    for (const [id, request] of modelRequests.current) {
      if (!ids.has(id)) modelRequests.current.set(id, request + 1);
    }
    setModels((answers) => onlyListed(answers, ids));
    setImageModels((answers) => onlyListed(answers, ids));
  }, []);

  const loadModels = useCallback(
    (id: string, refresh = false) =>
      loadEntryModels(
        { disposed, list: listRef, requests: modelRequests.current, setModels, setImageModels },
        id,
        refresh,
      ),
    [],
  );

  // Only the newest reload may take its answer; an older one arriving later is dropped.
  const reloadRequest = useRef(0);
  const listReads = useRef(0);
  const reload = useCallback(
    () =>
      reloadList({
        disposed,
        list: listRef,
        request: reloadRequest,
        inFlight: listReads,
        takeList,
        setLoading,
        setFailed,
        setReloadFailed,
        loadModels,
      }),
    [loadModels, takeList],
  );

  // A list read before a save or a delete answered may predate it: a fresh reload supersedes it.
  const supersedeStaleReload = useCallback(() => {
    if (listReads.current > 0) void reload().catch(() => {});
  }, [reload]);

  useEffect(() => {
    disposed.current = false;
    // A failed first load leaves `list` null and sets `failed`; the screens offer a retry.
    void reload().catch(() => {});
    return () => {
      disposed.current = true;
    };
  }, [reload]);

  const checkAll = useCallback(() => {
    for (const entry of listRef.current?.providers ?? []) void loadModels(entry.id, true);
  }, [loadModels]);

  const save = useCallback(
    async (input: SaveProvider) => {
      const view = await call('providers:save', input);
      if (!disposed.current) {
        takeList(upsert(listRef.current, view));
        void loadModels(view.id);
        supersedeStaleReload();
      }
      return view;
    },
    [loadModels, takeList, supersedeStaleReload],
  );

  const remove = useCallback(
    async (id: string) => {
      await call('providers:delete', { id });
      if (disposed.current) return;
      // A late answer for the deleted entry is dropped.
      modelRequests.current.set(id, (modelRequests.current.get(id) ?? 0) + 1);
      const current = listRef.current;
      if (current !== null) takeList(withoutEntry(current, id));
      setModels((answers) => without(answers, id));
      setImageModels((answers) => without(answers, id));
      supersedeStaleReload();
    },
    [takeList, supersedeStaleReload],
  );

  const noteUsed = useCallback(
    (id: string) => {
      const current = listRef.current;
      // An id the list does not hold has no known purpose: it is never recorded.
      if (current === null || !current.providers.some((entry) => entry.id === id)) return;
      const slot = purposeOfEntry(current, id) === 'image' ? 'lastUsedImageId' : 'lastUsedId';
      if (current[slot] !== id) takeList({ ...current, [slot]: id });
    },
    [takeList],
  );

  const value = useMemo<ProvidersState>(
    () => ({
      list,
      loading,
      failed,
      reloadFailed,
      models,
      imageModels,
      reload,
      loadModels,
      checkAll,
      save,
      remove,
      noteUsed,
    }),
    [list, loading, failed, reloadFailed, models, imageModels, reload, loadModels, checkAll, save, remove, noteUsed],
  );

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

/**
 * The state of the surrounding `ProviderSettingsProvider`.
 *
 * @returns the state; outside a provider the empty state
 */
export function useProviders(): ProvidersState {
  return useContext(ProvidersContext);
}

/** The model list failures that mean the provider cannot be reached. */
const UNREACHABLE: ReadonlySet<string> = new Set(['provider_unreachable', 'provider_timeout', 'provider_unavailable']);

/**
 * The state of an entry whose model list failed.
 *
 * @param failure the failed answer
 * @returns the state
 */
function failureStatus(failure: ModelsFailure): ProviderStatus {
  if (UNREACHABLE.has(failure.code)) return 'unreachable';
  if (failure.code === 'provider_unauthorized') return 'unauthorized';
  return 'error';
}

/**
 * The state of entry `id` from its model list answer: the edit model list for an entry of the image
 * purpose (`venice`), the vision model list for a vision entry (`ollama` or `openai`) and for an entry
 * that is not listed.
 *
 * @param state the provider list and the model list answers
 * @param id the entry
 * @returns the state
 */
export function providerStatus(
  state: Pick<ProvidersState, 'list' | 'models' | 'imageModels'>,
  id: string,
): ProviderStatus {
  if (purposeOfEntry(state.list, id) === 'image') {
    const answer = state.imageModels[id];
    if (answer === undefined || answer === 'checking') return 'checking';
    if (answer.ok) return answer.models.length > 0 ? 'ready' : 'no_edit_model';
    return failureStatus(answer);
  }
  const answer = state.models[id];
  if (answer === undefined) return 'checking';
  if (answer.ok) return answer.models.some((model) => model.vision !== false) ? 'ready' : 'no_vision_model';
  return failureStatus(answer);
}

/**
 * The entry of `purpose` a dialog preselects: the one of that purpose used last when it is still listed,
 * otherwise the first of that purpose.
 *
 * @param state the provider list
 * @param purpose the purpose of the dialog; `vision` unless given
 * @returns the entry, null without any
 */
export function defaultProviderId(
  state: Pick<ProvidersState, 'list'>,
  purpose: ProviderPurpose = 'vision',
): string | null {
  const list = state.list;
  if (list === null) return null;
  const providers = list.providers.filter((entry) => purposeOf(entry.kind) === purpose);
  const lastUsed = purpose === 'image' ? list.lastUsedImageId : list.lastUsedId;
  return providers.find((entry) => entry.id === lastUsed)?.id ?? providers[0]?.id ?? null;
}

/**
 * The stored default model of entry `id` for `purpose`.
 *
 * @param state the provider list
 * @param id the entry; null for none
 * @param purpose tagging or Image to prompt
 * @returns the model; null when there is none or the entry is not listed
 */
export function defaultModelOf(
  state: Pick<ProvidersState, 'list'>,
  id: string | null,
  purpose: 'tagging' | 'prompt',
): string | null {
  const entry = id === null ? undefined : state.list?.providers.find((provider) => provider.id === id);
  if (entry === undefined) return null;
  return purpose === 'tagging' ? entry.taggingModel : entry.promptModel;
}

/**
 * The edit model `venice` entry `id` starts with: its stored `editModel` when the loaded list
 * contains it, else the first listed one (null for an empty list). Without a usable list (still
 * asked or failed) the stored model stands. Null for an entry that is not a listed `venice` one.
 *
 * @param state the provider list and the edit model list answers
 * @param id the entry; null for none
 * @returns the model, or null
 */
export function defaultEditModelOf(
  state: Pick<ProvidersState, 'list' | 'imageModels'>,
  id: string | null,
): string | null {
  const entry = id === null ? undefined : state.list?.providers.find((provider) => provider.id === id);
  if (entry === undefined || entry.kind !== 'venice') return null;
  const answer = state.imageModels[entry.id];
  if (answer === undefined || answer === 'checking' || !answer.ok) return entry.editModel;
  if (entry.editModel !== null && answer.models.some((model) => model.name === entry.editModel)) return entry.editModel;
  return answer.models[0]?.name ?? null;
}
