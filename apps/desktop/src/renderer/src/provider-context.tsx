import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  JobErrorCodeSchema,
  type ListImageModelsResult,
  type ListModelsResult,
  purposeOf,
  type ProviderPurpose,
  type ProviderList,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import { ApiError, call } from './api';

export type ProviderStatus =
  | 'checking'
  | 'ready'
  | 'unreachable'
  | 'unauthorized'
  | 'no_vision_model'
  | 'no_edit_model'
  | 'error';

export interface ProvidersState {
  /** Null until the first answer; a later failed reload keeps the list held. */
  list: ProviderList | null;
  /** True while the list loads. */
  loading: boolean;
  /** True when loading failed and no list is held (not the same as "no provider"). */
  failed: boolean;
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
  remove(id: string): Promise<void>;
  /** Records locally what the main process stored after an analysis start, so the next dialog preselects it. */
  noteUsed(id: string): void;
}

const EMPTY: ProvidersState = {
  list: null,
  loading: false,
  failed: false,
  models: {},
  imageModels: {},
  reload: async () => {},
  loadModels: async () => {},
  checkAll: () => {},
  save: () => Promise.reject(new Error('No provider settings')),
  remove: () => Promise.reject(new Error('No provider settings')),
  noteUsed: () => {},
};

const ProvidersContext = createContext<ProvidersState>(EMPTY);

/** A failed call as a model list answer: its code when it is a job error code, otherwise a generic error. */
function failureOf(error: unknown): Extract<ListModelsResult, { ok: false }> {
  const code = error instanceof ApiError ? JobErrorCodeSchema.safeParse(error.code) : null;
  return { ok: false, code: code?.success ? code.data : 'internal_error' };
}

function upsert(list: ProviderList | null, view: ProviderView): ProviderList | null {
  if (list === null) return list;
  const providers = list.providers.some((p) => p.id === view.id)
    ? list.providers.map((p) => (p.id === view.id ? view : p))
    : [...list.providers, view];
  return { ...list, providers };
}

/** `record` without key `id`; the same object when it has none. */
function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const rest = { ...record };
  delete rest[id];
  return rest;
}

/** The purpose of entry `id`; an entry that is not listed counts as a vision entry. */
function purposeOfEntry(list: ProviderList | null | undefined, id: string): ProviderPurpose {
  const kind = list?.providers.find((p) => p.id === id)?.kind;
  return kind === undefined ? 'vision' : purposeOf(kind);
}

/**
 * The provider entries of the app and the model list of each. Loads the list once on mount and the
 * models of every entry in parallel; an answer for an entry is taken only when it is the newest
 * request for that entry. It does not poll.
 */
export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ProviderList | null>(null);
  const [models, setModels] = useState<Record<string, ListModelsResult | undefined>>({});
  const [imageModels, setImageModels] = useState<Record<string, ListImageModelsResult | 'checking'>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const disposed = useRef(false);
  const listRef = useRef<ProviderList | null>(null);
  // Per entry: only the newest model request may set its answer.
  const modelRequests = useRef(new Map<string, number>());

  const takeList = useCallback((next: ProviderList | null) => {
    listRef.current = next;
    setList(next);
  }, []);

  const loadModels = useCallback(async (id: string, refresh = false) => {
    const request = (modelRequests.current.get(id) ?? 0) + 1;
    modelRequests.current.set(id, request);
    const input = refresh ? { providerId: id, refresh: true } : { providerId: id };
    const newest = () => !disposed.current && modelRequests.current.get(id) === request;
    if (purposeOfEntry(listRef.current, id) === 'image') {
      setImageModels((m) => (m[id] === 'checking' ? m : { ...m, [id]: 'checking' }));
      let result: ListImageModelsResult;
      try {
        result = await call('providers:listImageModels', input);
      } catch (e) {
        result = failureOf(e);
      }
      if (newest()) setImageModels((m) => ({ ...m, [id]: result }));
      return;
    }
    setModels((m) => (m[id] === undefined ? m : { ...m, [id]: undefined }));
    let result: ListModelsResult;
    try {
      result = await call('providers:listModels', input);
    } catch (e) {
      result = failureOf(e);
    }
    if (newest()) setModels((m) => ({ ...m, [id]: result }));
  }, []);

  // Only the newest reload may take its answer; an older one arriving later is dropped.
  const reloadRequest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++reloadRequest.current;
    setLoading(true);
    let next: ProviderList;
    try {
      next = await call('providers:list', {});
    } catch (e) {
      if (request !== reloadRequest.current) return;
      // A list already held stays; only without one is the load a failure the screens show.
      if (!disposed.current) {
        if (listRef.current === null) setFailed(true);
        setLoading(false);
      }
      throw e;
    }
    if (disposed.current || request !== reloadRequest.current) return;
    takeList(next);
    setFailed(false);
    setLoading(false);
    await Promise.all(next.providers.map((p) => loadModels(p.id)));
  }, [loadModels, takeList]);

  useEffect(() => {
    disposed.current = false;
    // A failed first load leaves `list` null and sets `failed`; the screens offer a retry.
    void reload().catch(() => {});
    return () => {
      disposed.current = true;
    };
  }, [reload]);

  const checkAll = useCallback(() => {
    for (const p of listRef.current?.providers ?? []) void loadModels(p.id, true);
  }, [loadModels]);

  const save = useCallback(
    async (input: SaveProvider) => {
      const view = await call('providers:save', input);
      if (!disposed.current) {
        takeList(upsert(listRef.current, view));
        void loadModels(view.id);
      }
      return view;
    },
    [loadModels, takeList],
  );

  const remove = useCallback(
    async (id: string) => {
      await call('providers:delete', { id });
      if (disposed.current) return;
      // A late answer for the deleted entry is dropped.
      modelRequests.current.set(id, (modelRequests.current.get(id) ?? 0) + 1);
      const current = listRef.current;
      if (current !== null)
        takeList({
          ...current,
          providers: current.providers.filter((p) => p.id !== id),
          lastUsedId: current.lastUsedId === id ? null : current.lastUsedId,
          lastUsedImageId: current.lastUsedImageId === id ? null : current.lastUsedImageId,
        });
      setModels((m) => without(m, id));
      setImageModels((m) => without(m, id));
    },
    [takeList],
  );

  const noteUsed = useCallback(
    (id: string) => {
      const current = listRef.current;
      if (current !== null && current.lastUsedId !== id) takeList({ ...current, lastUsedId: id });
    },
    [takeList],
  );

  const value = useMemo<ProvidersState>(
    () => ({ list, loading, failed, models, imageModels, reload, loadModels, checkAll, save, remove, noteUsed }),
    [list, loading, failed, models, imageModels, reload, loadModels, checkAll, save, remove, noteUsed],
  );

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

/** The state of the surrounding `ProviderSettingsProvider`; outside one the empty state. */
export function useProviders(): ProvidersState {
  return useContext(ProvidersContext);
}

const UNREACHABLE: ReadonlySet<string> = new Set(['provider_unreachable', 'provider_timeout', 'provider_unavailable']);

/**
 * The state of entry `id` from its model list answer: the edit model list for an entry of the image
 * purpose (`venice`), the vision model list for a vision entry (`ollama` or `openai`) and for an entry
 * that is not listed.
 */
export function providerStatus(
  state: Pick<ProvidersState, 'list' | 'models' | 'imageModels'>,
  id: string,
): ProviderStatus {
  let failure: Extract<ListModelsResult, { ok: false }>;
  if (purposeOfEntry(state.list, id) === 'image') {
    const answer = state.imageModels[id];
    if (answer === undefined || answer === 'checking') return 'checking';
    if (answer.ok) return answer.models.length > 0 ? 'ready' : 'no_edit_model';
    failure = answer;
  } else {
    const answer = state.models[id];
    if (answer === undefined) return 'checking';
    if (answer.ok) return answer.models.some((m) => m.vision !== false) ? 'ready' : 'no_vision_model';
    failure = answer;
  }
  if (UNREACHABLE.has(failure.code)) return 'unreachable';
  if (failure.code === 'provider_unauthorized') return 'unauthorized';
  return 'error';
}

/**
 * The entry of `purpose` a dialog preselects: the one of that purpose used last when it is still listed,
 * otherwise the first of that purpose; null without any.
 */
export function defaultProviderId(state: Pick<ProvidersState, 'list'>, purpose: ProviderPurpose = 'vision'): string | null {
  const list = state.list;
  if (list === null) return null;
  const providers = list.providers.filter((p) => purposeOf(p.kind) === purpose);
  const lastUsed = purpose === 'image' ? list.lastUsedImageId : list.lastUsedId;
  return providers.find((p) => p.id === lastUsed)?.id ?? providers[0]?.id ?? null;
}

/** The stored default model of entry `id` for `purpose`; null when there is none or the entry is not listed. */
export function defaultModelOf(
  state: Pick<ProvidersState, 'list'>,
  id: string | null,
  purpose: 'tagging' | 'prompt',
): string | null {
  const entry = id === null ? undefined : state.list?.providers.find((p) => p.id === id);
  if (entry === undefined) return null;
  return purpose === 'tagging' ? entry.taggingModel : entry.promptModel;
}

/**
 * The edit model `venice` entry `id` starts with: its stored `editModel` when the loaded list
 * contains it, else the first listed one (null for an empty list). Without a usable list (still
 * asked or failed) the stored model stands. Null for an entry that is not a listed `venice` one.
 */
export function defaultEditModelOf(state: Pick<ProvidersState, 'list' | 'imageModels'>, id: string | null): string | null {
  const entry = id === null ? undefined : state.list?.providers.find((p) => p.id === id);
  if (entry === undefined || entry.kind !== 'venice') return null;
  const answer = state.imageModels[entry.id];
  if (answer === undefined || answer === 'checking' || !answer.ok) return entry.editModel;
  if (entry.editModel !== null && answer.models.some((m) => m.name === entry.editModel)) return entry.editModel;
  return answer.models[0]?.name ?? null;
}
