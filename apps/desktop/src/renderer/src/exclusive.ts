// One action at a time behind a synchronous guard: a second activation before the re-render must not send a
// second request.

/** A synchronous guard, usually a ref: true while an action runs. */
export interface Guard {
  /** Whether an action runs. */
  current: boolean;
}

/** What happens around a guarded action. */
export interface ExclusiveLifecycle {
  /** Runs after the guard is taken, before the action. */
  onStart?(): void;
  /** Runs after the guard is released, also when the action failed. */
  onEnd?(): void;
}

/**
 * Runs an action unless one already runs; later activations while it runs are ignored.
 *
 * @param guard the guard
 * @param action the action
 * @param lifecycle what happens before and after it
 * @returns settles when the action has; rejects with its failure
 */
export async function runExclusive(guard: Guard, action: () => Promise<void>, lifecycle: ExclusiveLifecycle = {}): Promise<void> {
  if (guard.current) return;
  guard.current = true;
  lifecycle.onStart?.();
  try {
    await action();
  } finally {
    guard.current = false;
    lifecycle.onEnd?.();
  }
}
