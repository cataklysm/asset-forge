import { createContext, useContext } from 'react';

// The shell's "storage reachable again" signal: a counter the shell raises every time the user leaves the
// unreachable state through Retry on the storage banner. Images that failed to load try again on a new value.

/** The counter; 0 outside the shell. */
export const StorageReturnContext = createContext(0);

/**
 * The shell's storage return counter.
 *
 * @returns a number that changes every time the storage counts as reachable again
 */
export function useStorageReturn(): number {
  return useContext(StorageReturnContext);
}
