import type { JobErrorCode, ResourceClass } from '@assetforge/contracts';

/** Consecutive provider-down runs after which a resource class pauses. */
export const DEFAULT_PAUSE_THRESHOLD = 3;

/** Codes that say the provider is down; they pause a class once they repeat `threshold` times in a row. */
const DOWN: ReadonlySet<JobErrorCode> = new Set(['provider_unreachable', 'provider_unavailable', 'provider_timeout']);
/** Codes that pause a class at once: no later run can succeed until the settings change. */
const FATAL: ReadonlySet<JobErrorCode> = new Set(['provider_unauthorized', 'provider_not_configured']);

/**
 * Pause state per resource class. It belongs to the app session and outlives every scheduler that is handed it;
 * it is not persisted.
 */
export interface PauseGate {
  /** The code that paused the class, or null while it may claim. */
  reason(rc: ResourceClass): JobErrorCode | null;
  /** The end of one run: 'ok' for a success, 'other' for a cancel, a release on stop or a non-provider error. */
  record(rc: ResourceClass, outcome: JobErrorCode | 'ok' | 'other'): void;
  /** Ends the pause of the class and clears its count. The caller wakes the scheduler. */
  resume(rc: ResourceClass): void;
}

export interface PauseGateOptions {
  threshold?: number;
  /** Called when a class pauses and when a paused class resumes, never otherwise. */
  onChange?: () => void;
}

export function createPauseGate(options: PauseGateOptions): PauseGate {
  const threshold = options.threshold ?? DEFAULT_PAUSE_THRESHOLD;
  const counts = new Map<ResourceClass, number>();
  const reasons = new Map<ResourceClass, JobErrorCode>();

  return {
    reason: (rc) => reasons.get(rc) ?? null,

    record(rc, outcome) {
      // A paused class keeps its first reason until resume; runs that were in flight do not change it.
      if (reasons.has(rc)) return;
      if (outcome === 'ok' || outcome === 'other' || !(DOWN.has(outcome) || FATAL.has(outcome))) {
        counts.delete(rc);
        return;
      }
      const n = FATAL.has(outcome) ? threshold : (counts.get(rc) ?? 0) + 1;
      if (n < threshold) {
        counts.set(rc, n);
        return;
      }
      counts.delete(rc);
      reasons.set(rc, outcome);
      options.onChange?.();
    },

    resume(rc) {
      counts.delete(rc);
      if (!reasons.delete(rc)) return;
      options.onChange?.();
    },
  };
}
