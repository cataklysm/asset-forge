import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  JobErrorCodeSchema,
  purposeOf,
  type ListImageModelsResult,
  type ListModelsResult,
  type ProviderList,
  type ProviderPurpose,
} from '@assetforge/contracts';
import { ApiError, call } from './api';

// The list and model loads of the provider context, kept apart from its React state.
/** A model list answer that is a failure. */
export type ModelsFailure = Extract<ListModelsResult, { ok: false }>;

/** The vision model list answers by entry. */
export type VisionModels = Record<string, ListModelsResult | undefined>;

/** The edit model list answers by entry. */
export type ImageModels = Record<string, ListImageModelsResult | 'checking'>;

/** What loading the models of one entry reads and writes. */
export interface ModelLoading {
  disposed: MutableRefObject<boolean>;
  list: MutableRefObject<ProviderList | null>;
  /** Per entry: only the newest model request may set its answer. */
  requests: Map<string, number>;
  setModels: Dispatch<SetStateAction<VisionModels>>;
  setImageModels: Dispatch<SetStateAction<ImageModels>>;
}

/** What reloading the list reads and writes. */
export interface ListLoading {
  disposed: MutableRefObject<boolean>;
  list: MutableRefObject<ProviderList | null>;
  /** Only the newest reload may take its answer. */
  request: MutableRefObject<number>;
  /** The number of list reads whose answer has not come yet. */
  inFlight: MutableRefObject<number>;
  takeList(next: ProviderList | null): void;
  setLoading(loading: boolean): void;
  setFailed(failed: boolean): void;
  setReloadFailed(failed: boolean): void;
  loadModels(id: string): Promise<void>;
}

/**
 * A failed call as a model list answer.
 *
 * @param error what the call rejected with
 * @returns its code when it is a job error code, otherwise a generic error
 */
export function failureOf(error: unknown): ModelsFailure {
  const code = error instanceof ApiError ? JobErrorCodeSchema.safeParse(error.code) : null;
  return { ok: false, code: code?.success ? code.data : 'internal_error' };
}

/**
 * The purpose of entry `id`; an entry that is not listed counts as a vision entry.
 *
 * @param list the held list
 * @param id the entry
 * @returns its purpose
 */
export function purposeOfEntry(list: ProviderList | null | undefined, id: string): ProviderPurpose {
  const kind = list?.providers.find((entry) => entry.id === id)?.kind;
  return kind === undefined ? 'vision' : purposeOf(kind);
}

/**
 * Asks for the models of one entry by its purpose; only the newest request for the entry sets its answer.
 * A re-check (`refresh`) keeps the last answer until the new one comes, so a ready entry stays usable
 * meanwhile; any other request first drops it, since it follows a change of the entry.
 *
 * @param loading the refs and setters
 * @param id the entry
 * @param refresh asks the provider instead of the main process cache
 * @returns resolves once the answer is taken or dropped; never rejects
 */
export async function loadEntryModels(loading: ModelLoading, id: string, refresh: boolean): Promise<void> {
  const request = (loading.requests.get(id) ?? 0) + 1;
  loading.requests.set(id, request);
  const input = refresh ? { providerId: id, refresh: true } : { providerId: id };
  const isNewest = () => !loading.disposed.current && loading.requests.get(id) === request;
  if (purposeOfEntry(loading.list.current, id) === 'image') {
    loading.setImageModels((answers) =>
      answers[id] === 'checking' || (refresh && answers[id] !== undefined) ? answers : { ...answers, [id]: 'checking' },
    );
    let result: ListImageModelsResult;
    try {
      result = await call('providers:listImageModels', input);
    } catch (error) {
      result = failureOf(error);
    }
    if (isNewest()) loading.setImageModels((answers) => ({ ...answers, [id]: result }));
    return;
  }
  if (!refresh) loading.setModels((answers) => (answers[id] === undefined ? answers : { ...answers, [id]: undefined }));
  let result: ListModelsResult;
  try {
    result = await call('providers:listModels', input);
  } catch (error) {
    result = failureOf(error);
  }
  if (isNewest()) loading.setModels((answers) => ({ ...answers, [id]: result }));
}

/**
 * Loads the list again, then the model list of every entry. An older reload arriving later is dropped.
 *
 * @param loading the refs, setters and the model loader
 * @returns resolves once the models were asked; rejects when the list cannot be read
 */
export async function reloadList(loading: ListLoading): Promise<void> {
  const request = ++loading.request.current;
  loading.setLoading(true);
  let next: ProviderList;
  loading.inFlight.current += 1;
  try {
    next = await call('providers:list', {});
  } catch (error) {
    loading.inFlight.current -= 1;
    if (request !== loading.request.current) return;
    // A list already held stays usable; the settings show that it could not be reloaded.
    if (!loading.disposed.current) {
      if (loading.list.current === null) loading.setFailed(true);
      else loading.setReloadFailed(true);
      loading.setLoading(false);
    }
    throw error;
  }
  loading.inFlight.current -= 1;
  if (loading.disposed.current || request !== loading.request.current) return;
  loading.takeList(next);
  loading.setFailed(false);
  loading.setReloadFailed(false);
  loading.setLoading(false);
  await Promise.all(next.providers.map((entry) => loading.loadModels(entry.id)));
}
