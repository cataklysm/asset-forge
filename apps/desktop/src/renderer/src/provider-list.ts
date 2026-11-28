import type { ProviderList, ProviderView } from '@assetforge/contracts';

// Pure helpers of the provider context: the held entry list and the records keyed by entry id.

/**
 * `list` with `view` in place of the entry of the same id, or added at the end.
 *
 * @param list the held list; null while none is held
 * @param view the saved entry
 * @returns the new list, null while none is held
 */
export function upsert(list: ProviderList | null, view: ProviderView): ProviderList | null {
  if (list === null) return list;
  const providers = list.providers.some((entry) => entry.id === view.id)
    ? list.providers.map((entry) => (entry.id === view.id ? view : entry))
    : [...list.providers, view];
  return { ...list, providers };
}

/**
 * `record` without key `id`.
 *
 * @param record the record
 * @param id the key to drop
 * @returns the new record; the same object when it has no such key
 */
export function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const rest = { ...record };
  delete rest[id];
  return rest;
}

/**
 * `record` with only the keys in `ids`.
 *
 * @param record the record
 * @param ids the keys to keep
 * @returns the new record; the same object when every key is kept
 */
export function onlyListed<T>(record: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  const dropped = Object.keys(record).filter((id) => !ids.has(id));
  if (dropped.length === 0) return record;
  const rest = { ...record };
  for (const id of dropped) delete rest[id];
  return rest;
}

/**
 * `list` without entry `id`, and without it as the entry used last.
 *
 * @param list the held list
 * @param id the deleted entry
 * @returns the new list
 */
export function withoutEntry(list: ProviderList, id: string): ProviderList {
  return {
    ...list,
    providers: list.providers.filter((entry) => entry.id !== id),
    lastUsedId: list.lastUsedId === id ? null : list.lastUsedId,
    lastUsedImageId: list.lastUsedImageId === id ? null : list.lastUsedImageId,
  };
}
