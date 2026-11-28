import type { ResourceClass } from '@assetforge/contracts';

/** How many lanes of one class the rotation remembers; the lanes served longer ago count as not served. */
export const ROTATION_MEMORY = 8;

/**
 * The lanes of each class in the order they were last served, so that a claim under a class total prefers a lane that
 * waited longest over the lane of the oldest job. Without it, a large batch for one lane would hold every place of the
 * total until it is done, and a later small batch for another lane would wait behind all of it.
 */
export class LaneRotation {
  /** The lanes served per class, the newest first, at most `ROTATION_MEMORY` of them. */
  private readonly served = new Map<ResourceClass, (string | null)[]>();

  /**
   * Records that a job of a lane was launched.
   *
   * @param resourceClass the class of the job
   * @param lane the lane of the job
   */
  record(resourceClass: ResourceClass, lane: string | null): void {
    const lanes = (this.served.get(resourceClass) ?? []).filter((candidate) => candidate !== lane);
    lanes.unshift(lane);
    this.served.set(resourceClass, lanes.slice(0, ROTATION_MEMORY));
  }

  /**
   * The lane sets to leave out of a claim, tried in order until a claim finds a job: first every lane served
   * recently, then one lane fewer each time, the one served longest ago first, and last none of them.
   *
   * @param resourceClass the class of the claim
   * @returns the sets of served lanes to leave out, the largest first and always ending with the empty set
   */
  preferences(resourceClass: ResourceClass): (string | null)[][] {
    const lanes = this.served.get(resourceClass) ?? [];
    const sets: (string | null)[][] = [];
    for (let keep = lanes.length; keep >= 0; keep--) sets.push(lanes.slice(0, keep));
    return sets;
  }
}
