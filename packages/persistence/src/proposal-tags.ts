import type { Proposal } from '@assetforge/core';

/**
 * The stored tag list; anything but an array of `{ name, displayName }` strings reads as [].
 *
 * @param json the column text
 * @returns the tags; invalid entries are left out
 */
export function parseTags(json: string): Proposal['tags'] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, displayName } = entry as { name?: unknown; displayName?: unknown };
    return typeof name === 'string' && typeof displayName === 'string' ? [{ name, displayName }] : [];
  });
}
