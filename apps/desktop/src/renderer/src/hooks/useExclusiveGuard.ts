import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { runExclusive, type ExclusiveLifecycle, type Guard } from '../exclusive';

/** What `useExclusiveGuard` offers. */
export interface ExclusiveGuard {
  /** True while an action runs; mirrors the synchronous guard for rendering controls disabled. */
  busy: boolean;
  /** Runs an action unless one already runs; settles when it has and rejects with its failure. */
  run(action: () => Promise<void>, lifecycle?: ExclusiveLifecycle): Promise<void>;
}

/** What one guarded run reads and writes. */
interface GuardState {
  /** The synchronous guard. */
  guard: Guard;
  /** False once the component unmounted; no state update happens then. */
  mounted: MutableRefObject<boolean>;
  /** Sets the rendered busy flag. */
  setBusy(busy: boolean): void;
}

/**
 * Runs an action behind the guard and mirrors the guard in the busy flag, also when the action fails.
 *
 * @param state the guard, the mounted flag and the setter
 * @param action the action
 * @param lifecycle what happens before and after it
 * @returns settles when the action has; rejects with its failure
 */
function runGuarded(state: GuardState, action: () => Promise<void>, lifecycle: ExclusiveLifecycle): Promise<void> {
  return runExclusive(state.guard, action, {
    onStart: () => {
      state.setBusy(true);
      lifecycle.onStart?.();
    },
    onEnd: () => {
      if (state.mounted.current) state.setBusy(false);
      lifecycle.onEnd?.();
    },
  });
}

/**
 * One action at a time: a synchronous guard that answers at once, and a busy flag that renders the controls of
 * every action behind it disabled while one runs.
 *
 * @returns the busy flag and the run function
 */
export function useExclusiveGuard(): ExclusiveGuard {
  const guard = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state: GuardState = { guard, mounted, setBusy };
  return { busy, run: (action, lifecycle = {}) => runGuarded(state, action, lifecycle) };
}
