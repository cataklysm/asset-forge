import { useEffect, useRef, type RefObject } from 'react';
import type { ViewPosition } from './useVirtualRows';

// Keeps a list screen's scroll offset in the state the shell holds, when the screen is left.

/**
 * Leaving the screen keeps the filters (already in `state`) and the scroll offset: on unmount the offset of the
 * mounted view goes into the latest state.
 *
 * @param positionRef the mounted view's position; null keeps the state as it is
 * @param state the screen's list state
 * @param onStateChange hands the state to the shell
 */
export function useKeptScrollOffset<S extends { scrollOffset: number }>(
  positionRef: RefObject<ViewPosition | null>,
  state: S,
  onStateChange: (state: S) => void,
): void {
  const latest = useRef({ state, onStateChange });
  latest.current = { state, onStateChange };
  useEffect(
    () => () => {
      const position = positionRef.current;
      if (position === null) return;
      const current = latest.current;
      current.onStateChange({ ...current.state, scrollOffset: position.scrollOffset });
    },
    [],
  );
}
