import type { Proposal } from '@assetforge/core';

/** The stored tag list; anything but an array of `{ name, displayName }` strings reads as []. */
export function parseTags(json: string): Proposal['tags'] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((t: unknown) => {
    if (typeof t !== 'object' || t === null) return [];
    const { name, displayName } = t as { name?: unknown; displayName?: unknown };
    return typeof name === 'string' && typeof displayName === 'string' ? [{ name, displayName }] : [];
  });
}
