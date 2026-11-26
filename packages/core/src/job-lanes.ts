import { analysisJobFields, ANALYZE_FILE_JOB } from '@assetforge/contracts';
import { adoptForProvider, rewriteForProvider } from './analysis-payload.js';
import { InvalidOperationError } from './errors.js';
import type { WorkspaceSession } from './session.js';

/**
 * Moves every waiting (`queued` or `retry_wait`) analysis job of `fromLane` onto the provider `to` with
 * `model`, in one transaction: payload v4 with the new name and model (prompt and mode kept), attempt 0,
 * due at once. Running and finished jobs stay. The host checks that `to` exists and wakes the scheduler.
 */
export async function rerouteJobs(
  s: WorkspaceSession,
  r: { fromLane: string | null; to: { id: string; name: string }; model: string },
): Promise<{ moved: number }> {
  if (r.fromLane === r.to.id) throw new InvalidOperationError('Jobs cannot be moved onto the same provider');
  const to = { name: r.to.name, model: r.model };
  const moved = await s.database.jobs.rerouteWaiting({
    type: ANALYZE_FILE_JOB,
    fromLane: r.fromLane,
    toLane: r.to.id,
    rewrite: (payload) => rewriteForProvider(payload, to),
    now: s.now().toISOString(),
  });
  return { moved };
}

/**
 * Assigns every active analysis job without a provider to `entry` (payload v4 keeping its model, mode and
 * prompt). A v1 row stays unassigned when the entry has no tagging model. Returns how many were assigned.
 */
export function assignUnroutedJobs(
  s: WorkspaceSession,
  entry: { id: string; name: string; taggingModel: string | null },
): Promise<number> {
  return s.database.jobs.assignLane({
    type: ANALYZE_FILE_JOB,
    lane: entry.id,
    rewrite: (payload) => adoptForProvider(payload, entry),
    now: s.now().toISOString(),
  });
}

/** The provider name in the newest analysis job of the lane; null when there is none or it predates payload v4. */
export async function laneName(s: WorkspaceSession, lane: string | null): Promise<string | null> {
  const payload = await s.database.jobs.latestPayloadOfLane(ANALYZE_FILE_JOB, lane);
  return payload === null ? null : analysisJobFields(payload).providerName;
}

/** The waiting analysis jobs per lane, with the provider name from the lane's newest payload. */
export async function listWaitingLanes(
  s: WorkspaceSession,
): Promise<{ lane: string | null; payloadName: string | null; waiting: number }[]> {
  const lanes = await s.database.jobs.waitingByLane(ANALYZE_FILE_JOB);
  const result: { lane: string | null; payloadName: string | null; waiting: number }[] = [];
  for (const { lane, waiting } of lanes) result.push({ lane, payloadName: await laneName(s, lane), waiting });
  return result;
}

/** Analysis jobs of the lane in `queued`, `retry_wait`, `running` or `waiting_remote`. */
export function countActiveAnalysisJobs(s: WorkspaceSession, lane: string): Promise<number> {
  return s.database.jobs.countActiveInLane(ANALYZE_FILE_JOB, lane);
}
