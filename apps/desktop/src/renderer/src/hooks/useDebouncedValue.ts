import { useEffect, useState } from 'react';

export const SEARCH_DEBOUNCE_MS = 250;

/**
 * `value` once it has stayed unchanged for `delayMs`. The empty string passes through at once,
 * so clearing a search (Esc) takes effect immediately.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === '') return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  // An empty value is never delayed; reading it during render avoids an extra pass.
  if (value === '' && settled !== value) setSettled(value);
  return value === '' ? value : settled;
}
