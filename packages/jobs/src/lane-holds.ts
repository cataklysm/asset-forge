import type { ResourceClass } from '@assetforge/contracts';

/** One held lane of a class and the time it may claim again. */
interface LaneHold {
  /** The class of the lane. */
  resourceClass: ResourceClass;
  /** The lane, null for jobs without one. */
  lane: string | null;
  /** The end of the hold, in milliseconds since the epoch. */
  until: number;
}

/**
 * The lanes a scheduler holds in memory after a job asked for a wait (`JobError.retryAfterMs`). The hold in the
 * database only moves the jobs waiting when it is written; this one also keeps jobs enqueued or retried into the lane
 * afterwards from being claimed before its end. It lives as long as the scheduler.
 */
export class LaneHolds {
  /** The holds by class and lane. */
  private readonly holds = new Map<string, LaneHold>();

  /**
   * Holds a lane until `until`; a later end already held stays.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   * @param until the end of the hold, in milliseconds since the epoch
   */
  hold(resourceClass: ResourceClass, lane: string | null, until: number): void {
    const key = keyOf(resourceClass, lane);
    const current = this.holds.get(key);
    if (current !== undefined && current.until >= until) return;
    this.holds.set(key, { resourceClass, lane, until });
  }

  /**
   * The lanes of a class held at `now`; holds that have ended are dropped.
   *
   * @param resourceClass the class
   * @param now the current time, in milliseconds since the epoch
   * @returns the held lanes
   */
  held(resourceClass: ResourceClass, now: number): (string | null)[] {
    return this.current(resourceClass, now).map((entry) => entry.lane);
  }

  /**
   * The earliest end of the holds of a class that are in force at `now`.
   *
   * @param resourceClass the class
   * @param now the current time, in milliseconds since the epoch
   * @returns the earliest end in milliseconds since the epoch; null when no lane of the class is held
   */
  earliestEnd(resourceClass: ResourceClass, now: number): number | null {
    const ends = this.current(resourceClass, now).map((entry) => entry.until);
    return ends.length === 0 ? null : Math.min(...ends);
  }

  /**
   * The holds of a class in force at `now`, after dropping every hold that has ended.
   *
   * @param resourceClass the class
   * @param now the current time, in milliseconds since the epoch
   * @returns the holds in force
   */
  private current(resourceClass: ResourceClass, now: number): LaneHold[] {
    const inForce: LaneHold[] = [];
    for (const [key, entry] of this.holds) {
      if (entry.until <= now) this.holds.delete(key);
      else if (entry.resourceClass === resourceClass) inForce.push(entry);
    }
    return inForce;
  }
}

/**
 * The map key of a class and a lane; a lane named like the empty string never meets lane null.
 *
 * @param resourceClass the class
 * @param lane the lane
 * @returns the key
 */
function keyOf(resourceClass: ResourceClass, lane: string | null): string {
  return JSON.stringify([resourceClass, lane]);
}
