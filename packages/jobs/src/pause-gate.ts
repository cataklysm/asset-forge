import type { JobErrorCode, ResourceClass } from '@assetforge/contracts';

/** Consecutive provider-down runs after which a lane pauses. */
export const DEFAULT_PAUSE_THRESHOLD = 3;

/** Codes that say the provider is down; they pause a lane once they repeat `threshold` times in a row. */
const DOWN: ReadonlySet<JobErrorCode> = new Set([
  'provider_unreachable',
  'provider_unavailable',
  'provider_timeout',
  'download_unreachable',
  'download_unavailable',
  'download_throttled',
  'download_blocked',
  'download_unauthorized',
  'download_forbidden',
]);
/**
 * Codes that pause a lane at once: no later run can succeed until the settings or the account change, or (for
 * `download_browser_check`) until the owner passed the site's check by hand in the profile's login window.
 */
const FATAL: ReadonlySet<JobErrorCode> = new Set([
  'provider_unauthorized',
  'provider_not_configured',
  'provider_insufficient_balance',
  'download_browser_check',
]);

/**
 * Pause state per resource class and lane. Jobs without a lane share the lane `null`, which pauses like any other.
 * It belongs to the app session and outlives every scheduler that is handed it; it is not persisted.
 */
export interface PauseGate {
  /** The code that paused the lane of the class, or null while it may claim. */
  reason(resourceClass: ResourceClass, lane: string | null): JobErrorCode | null;
  /** The end of one run: 'ok' for a success, 'other' for a cancel, a release on stop or a non-provider error. */
  record(resourceClass: ResourceClass, lane: string | null, outcome: JobErrorCode | 'ok' | 'other'): void;
  /** Ends the pause of the lane and clears its count. The caller wakes the scheduler. */
  resume(resourceClass: ResourceClass, lane: string | null): void;
  /** The paused lanes of the class with their reasons, in the order they paused. */
  paused(resourceClass: ResourceClass): { lane: string | null; reason: JobErrorCode }[];
}

export interface PauseGateOptions {
  threshold?: number;
  /** Called when a lane pauses and when a paused lane resumes, never otherwise. */
  onChange?: () => void;
}

export function createPauseGate(options: PauseGateOptions): PauseGate {
  const threshold = options.threshold ?? DEFAULT_PAUSE_THRESHOLD;
  const counts = new Map<ResourceClass, Map<string | null, number>>();
  const reasons = new Map<ResourceClass, Map<string | null, JobErrorCode>>();
  const of = <T>(maps: Map<ResourceClass, Map<string | null, T>>, rc: ResourceClass): Map<string | null, T> => {
    let map = maps.get(rc);
    if (!map) maps.set(rc, (map = new Map()));
    return map;
  };

  return {
    reason: (rc, lane) => reasons.get(rc)?.get(lane) ?? null,

    record(rc, lane, outcome) {
      const laneReasons = of(reasons, rc);
      // A paused lane keeps its first reason until resume; runs that were in flight do not change it.
      if (laneReasons.has(lane)) return;
      const laneCounts = of(counts, rc);
      if (outcome === 'ok' || outcome === 'other' || !(DOWN.has(outcome) || FATAL.has(outcome))) {
        laneCounts.delete(lane);
        return;
      }
      const n = FATAL.has(outcome) ? threshold : (laneCounts.get(lane) ?? 0) + 1;
      if (n < threshold) {
        laneCounts.set(lane, n);
        return;
      }
      laneCounts.delete(lane);
      laneReasons.set(lane, outcome);
      options.onChange?.();
    },

    resume(rc, lane) {
      counts.get(rc)?.delete(lane);
      if (!reasons.get(rc)?.delete(lane)) return;
      options.onChange?.();
    },

    paused: (rc) => [...(reasons.get(rc) ?? [])].map(([lane, reason]) => ({ lane, reason })),
  };
}
