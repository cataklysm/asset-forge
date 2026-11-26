import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  JobErrorCodeSchema,
  type ListModelsResult,
  type ProviderList,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import { ApiError, call } from './api';

export type ProviderStatus = 'checking' | 'ready' | 'unreachable' | 'unauthorized' | 'no_vision_model' | 'error';

export interface ProvidersState {
  /** Null until the first answer; a later failed reload keeps the list held. */
  list: ProviderList | null;
  /** True while the list loads. */
  loading: boolean;
  /** True when loading failed and no list is held (not the same as "no provider"). */
  failed: boolean;
  /** The model list answer per entry; undefined before the first answer and while a request runs. */
  models: Readonly<Record<string, ListModelsResult | undefined>>;
  /** Loads the list again, then the model list of every entry; rejects when the list cannot be read. */
  reload(): Promise<void>;
  /** Asks for the models of one entry; `refresh` asks the provider instead of the main process cache. Never rejects. */
  loadModels(id: string, refresh?: boolean): Promise<void>;
  /** Asks every entry with `refresh: true`, in parallel. */
  checkAll(): void;
  /** Saves, takes the returned entry into the list and loads its models. */
  save(input: SaveProvider): Promise<ProviderView>;
  remove(id: string): Promise<void>;
  /** Records locally what the main process stored after a start, so the next dialog preselects it. */
  noteUsed(id: string): void;
}

const EMPTY: ProvidersState = {
  list: null,
  loading: false,
  failed: false,
  models: {},
  reload: async () => {},
  loadModels: async () => {},
  checkAll: () => {},
  save: () => Promise.reject(new Error('No provider settings')),
  remove: () => Promise.reject(new Error('No provider settings')),
  noteUsed: () => {},
};

const ProvidersContext = createContext<ProvidersState>(EMPTY);

/** A failed call as a model list answer: its code when it is a job error code, otherwise a generic error. */
function failureOf(error: unknown): ListModelsResult {
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

/**
 * The provider entries of the app and the model list of each. Loads the list once on mount and the
 * models of every entry in parallel; an answer for an entry is taken only when it is the newest
 * request for that entry. It does not poll.
 */
export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ProviderList | null>(null);
  const [models, setModels] = useState<Record<string, ListModelsResult | undefined>>({});
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
    setModels((m) => (m[id] === undefined ? m : { ...m, [id]: undefined }));
    let result: ListModelsResult;
    try {
      result = await call('providers:listModels', refresh ? { providerId: id, refresh: true } : { providerId: id });
    } catch (e) {
      result = failureOf(e);
    }
    if (disposed.current || modelRequests.current.get(id) !== request) return;
    setModels((m) => ({ ...m, [id]: result }));
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
        });
      setModels((m) => {
        if (!(id in m)) return m;
        const rest = { ...m };
        delete rest[id];
        return rest;
      });
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
    () => ({ list, loading, failed, models, reload, loadModels, checkAll, save, remove, noteUsed }),
    [list, loading, failed, models, reload, loadModels, checkAll, save, remove, noteUsed],
  );

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

/** The state of the surrounding `ProviderSettingsProvider`; outside one the empty state. */
export function useProviders(): ProvidersState {
  return useContext(ProvidersContext);
}

const UNREACHABLE: ReadonlySet<string> = new Set(['provider_unreachable', 'provider_timeout', 'provider_unavailable']);

/** The state of entry `id` from its model list answer. */
export function providerStatus(state: Pick<ProvidersState, 'models'>, id: string): ProviderStatus {
  const answer = state.models[id];
  if (answer === undefined) return 'checking';
  if (answer.ok) return answer.models.some((m) => m.vision !== false) ? 'ready' : 'no_vision_model';
  if (UNREACHABLE.has(answer.code)) return 'unreachable';
  if (answer.code === 'provider_unauthorized') return 'unauthorized';
  return 'error';
}

/** The entry a dialog preselects: the one used last when it is still listed, otherwise the first; null without any. */
export function defaultProviderId(state: Pick<ProvidersState, 'list'>): string | null {
  const list = state.list;
  if (list === null) return null;
  return list.providers.find((p) => p.id === list.lastUsedId)?.id ?? list.providers[0]?.id ?? null;
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
