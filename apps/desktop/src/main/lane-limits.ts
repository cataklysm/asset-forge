import { isVisionKind, type ResourceClass } from '@assetforge/contracts';
import type { ProviderStore } from './provider-store.js';
import type { SiteProfileStore } from './site-profile-store.js';

/** A scheduler `laneLimit`: a number replaces the class limit for that lane, undefined keeps it. */
export type LaneLimit = (resourceClass: ResourceClass, lane: string | null) => number | undefined;

/**
 * The lane limit of the job host: for an analysis lane the `parallelRequests` of the vision entry with the lane's id,
 * read on every call so a saved value applies on the next claim; `undefined` for every other class, an unknown lane
 * and an entry without options, which keeps the class limit.
 *
 * @param store the provider entries
 * @returns the scheduler's `laneLimit` for analysis lanes
 */
export function providerLaneLimit(store: Pick<ProviderStore, 'get'>): LaneLimit {
  return (resourceClass, lane) => {
    if (resourceClass !== 'local_gpu' || lane === null) return undefined;
    const entry = store.get(lane);
    return entry !== null && isVisionKind(entry.kind) ? entry.options?.parallelRequests : undefined;
  };
}

/**
 * The downloads of one site profile run one after another: its jobs share the lane named after the profile's site,
 * and that lane takes one job at a time. Every other download lane keeps the class limit.
 *
 * @param sites the site profiles; read at every claim, so a new or deleted profile applies at once
 * @returns the scheduler's `laneLimit` for download lanes: 1 for the lane of a profile's site, otherwise undefined
 */
export function siteLaneLimit(sites: Pick<SiteProfileStore, 'list'>): LaneLimit {
  return (resourceClass, lane) =>
    resourceClass === 'io' && lane !== null && sites.list().some((profile) => profile.site === lane) ? 1 : undefined;
}
