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
  /**
   * The code that paused the lane of the class, or null while it may claim.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   * @returns the code that paused the lane, or null
   */
  reason(resourceClass: ResourceClass, lane: string | null): JobErrorCode | null;
  /**
   * The end of one run: 'ok' for a success, 'other' for a cancel, a release on stop or a non-provider error.
   *
   * @param resourceClass the class of the run
   * @param lane the lane of the run
   * @param outcome the run's error code, 'ok' or 'other'
   */
  record(resourceClass: ResourceClass, lane: string | null, outcome: JobErrorCode | 'ok' | 'other'): void;
  /**
   * Ends the pause of the lane and clears its count. The caller wakes the scheduler.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   */
  resume(resourceClass: ResourceClass, lane: string | null): void;
  /**
   * The paused lanes of the class with their reasons, in the order they paused.
   *
   * @param resourceClass the class
   * @returns one entry per paused lane
   */
  paused(resourceClass: ResourceClass): { lane: string | null; reason: JobErrorCode }[];
}

/** What `createPauseGate` is configured with. */
export interface PauseGateOptions {
  /** Consecutive provider-down runs after which a lane pauses. Default `DEFAULT_PAUSE_THRESHOLD`. */
  threshold?: number;
  /** Called when a lane pauses and when a paused lane resumes, never otherwise. */
  onChange?: () => void;
}

/**
 * Creates the pause gate of an app session.
 *
 * @param options the threshold and the change listener
 * @returns the gate, with no lane paused
 * @throws RangeError when the threshold is not an integer of at least 1
 */
export function createPauseGate(options: PauseGateOptions): PauseGate {
  const threshold = options.threshold ?? DEFAULT_PAUSE_THRESHOLD;
  // A threshold of 0, a fraction or NaN would pause on the first run or never; that is a wiring mistake.
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError('The pause threshold must be at least 1');
  const gate = new LanePauses(options, threshold);
  return {
    reason: (resourceClass, lane) => gate.reason(resourceClass, lane),
    record: (resourceClass, lane, outcome) => gate.record(resourceClass, lane, outcome),
    resume: (resourceClass, lane) => gate.resume(resourceClass, lane),
    paused: (resourceClass) => gate.paused(resourceClass),
  };
}

/**
 * Whether a run's outcome counts toward a pause.
 *
 * @param outcome the run's error code, 'ok' or 'other'
 * @returns true for a provider-down or a fatal code
 */
function countsTowardPause(outcome: JobErrorCode | 'ok' | 'other'): outcome is JobErrorCode {
  return outcome !== 'ok' && outcome !== 'other' && (DOWN.has(outcome) || FATAL.has(outcome));
}

/**
 * The lane of `maps` for one class, created empty on first use.
 *
 * @param maps per class the values by lane
 * @param resourceClass the class
 * @returns the class's map of values by lane
 */
function lanesOf<T>(
  maps: Map<ResourceClass, Map<string | null, T>>,
  resourceClass: ResourceClass,
): Map<string | null, T> {
  let map = maps.get(resourceClass);
  if (!map) maps.set(resourceClass, (map = new Map()));
  return map;
}

/** The counts and reasons of every class and lane; the methods are the gate's. */
class LanePauses {
  /** Consecutive provider-down runs per class and lane, for lanes not paused. */
  private readonly counts = new Map<ResourceClass, Map<string | null, number>>();
  /** The code that paused each paused lane, per class, in the order they paused. */
  private readonly reasons = new Map<ResourceClass, Map<string | null, JobErrorCode>>();

  /**
   * @param options the options as passed; `onChange` is read at every use
   * @param threshold consecutive provider-down runs after which a lane pauses
   */
  constructor(
    private readonly options: PauseGateOptions,
    private readonly threshold: number,
  ) {}

  /**
   * See `PauseGate.reason`.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   * @returns the code that paused the lane, or null
   */
  reason(resourceClass: ResourceClass, lane: string | null): JobErrorCode | null {
    return this.reasons.get(resourceClass)?.get(lane) ?? null;
  }

  /**
   * See `PauseGate.record`.
   *
   * @param resourceClass the class of the run
   * @param lane the lane of the run
   * @param outcome the run's error code, 'ok' or 'other'
   */
  record(resourceClass: ResourceClass, lane: string | null, outcome: JobErrorCode | 'ok' | 'other'): void {
    const laneReasons = lanesOf(this.reasons, resourceClass);
    // A paused lane keeps its first reason until resume; runs that were in flight do not change it.
    if (laneReasons.has(lane)) return;
    const laneCounts = lanesOf(this.counts, resourceClass);
    if (!countsTowardPause(outcome)) {
      laneCounts.delete(lane);
      return;
    }
    const count = FATAL.has(outcome) ? this.threshold : (laneCounts.get(lane) ?? 0) + 1;
    if (count < this.threshold) {
      laneCounts.set(lane, count);
      return;
    }
    laneCounts.delete(lane);
    laneReasons.set(lane, outcome);
    this.options.onChange?.();
  }

  /**
   * See `PauseGate.resume`.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   */
  resume(resourceClass: ResourceClass, lane: string | null): void {
    this.counts.get(resourceClass)?.delete(lane);
    if (!this.reasons.get(resourceClass)?.delete(lane)) return;
    this.options.onChange?.();
  }

  /**
   * See `PauseGate.paused`.
   *
   * @param resourceClass the class
   * @returns one entry per paused lane
   */
  paused(resourceClass: ResourceClass): { lane: string | null; reason: JobErrorCode }[] {
    return [...(this.reasons.get(resourceClass) ?? [])].map(([lane, reason]) => ({ lane, reason }));
  }
}
