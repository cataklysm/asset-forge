import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { StartKind } from '../studio-session';

/** What `useStartGuard` offers. */
export interface StartGuard {
  /** A start of `kind` for the source `fileId` is in flight. */
  starting(fileId: string, kind: StartKind): boolean;
  /** Runs `start` unless a start of `kind` for `fileId` is in flight; resolves false when it did not run. */
  guardStart(fileId: string, kind: StartKind, start: () => Promise<void>): Promise<boolean>;
}

/**
 * Runs `start` under `key` unless that key is in flight.
 *
 * @param inFlight the keys in flight; answers at once
 * @param setKeys renders the keys in flight
 * @param key the kind and source file
 * @param start the start to run
 * @returns false when it did not run, true once it ran; rejects with the start's failure
 */
async function runGuarded(
  inFlight: MutableRefObject<Set<string>>,
  setKeys: (keys: ReadonlySet<string>) => void,
  key: string,
  start: () => Promise<void>,
): Promise<boolean> {
  if (inFlight.current.has(key)) return false;
  inFlight.current.add(key);
  setKeys(new Set(inFlight.current));
  try {
    await start();
    return true;
  } finally {
    inFlight.current.delete(key);
    setKeys(new Set(inFlight.current));
  }
}

/**
 * A paid start: while one of a kind for a file is in flight, a repeated click for it sends nothing,
 * also from a studio mounted anew. The ref answers at once; the state renders the buttons disabled.
 *
 * @returns the guard and the check for starts in flight
 */
export function useStartGuard(): StartGuard {
  const inFlight = useRef(new Set<string>());
  const [startingKeys, setStartingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const guardStart = useCallback(
    (fileId: string, kind: StartKind, start: () => Promise<void>) =>
      runGuarded(inFlight, setStartingKeys, `${kind}:${fileId}`, start),
    [],
  );
  const starting = useCallback(
    (fileId: string, kind: StartKind) => startingKeys.has(`${kind}:${fileId}`),
    [startingKeys],
  );
  return { starting, guardStart };
}
