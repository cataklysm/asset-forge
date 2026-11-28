import { analysisJobFields, ANALYZE_FILE_JOB } from '@assetforge/contracts';
import { adoptForProvider, rewriteForProvider } from './analysis-payload.js';
import { InvalidOperationError } from './errors.js';
import type { WorkspaceSession } from './session.js';

/** The waiting analysis jobs of one lane. */
interface WaitingLane {
  /** The lane; null for jobs without a provider. */
  lane: string | null;
  /** The provider name in the lane's newest payload; null when there is none. */
  payloadName: string | null;
  /** The number of waiting jobs. */
  waiting: number;
}

/**
 * Moves every waiting (`queued` or `retry_wait`) analysis job of `fromLane` onto the provider `to` with
 * `model`, in one transaction: payload v4 with the new name and model (prompt and mode kept), attempt 0,
 * due at once. Running and finished jobs stay. The host checks that `to` exists and wakes the scheduler.
 *
 * @param session the open workspace
 * @param request the source lane, the target provider and the model
 * @returns how many jobs were moved
 * @throws `InvalidOperationError` when the source and the target are the same
 */
export async function rerouteJobs(
  session: WorkspaceSession,
  request: { fromLane: string | null; to: { id: string; name: string }; model: string },
): Promise<{ moved: number }> {
  if (request.fromLane === request.to.id) throw new InvalidOperationError('Jobs cannot be moved onto the same provider');
  const to = { name: request.to.name, model: request.model };
  const moved = await session.database.jobs.rerouteWaiting({
    type: ANALYZE_FILE_JOB,
    fromLane: request.fromLane,
    toLane: request.to.id,
    rewrite: (payload) => rewriteForProvider(payload, to),
    now: session.now().toISOString(),
  });
  return { moved };
}

/**
 * Assigns every active analysis job without a provider to `entry` (payload v4 keeping its model, mode and
 * prompt). A v1 row stays unassigned when the entry has no tagging model.
 *
 * @param session the open workspace
 * @param entry the provider entry
 * @returns how many were assigned
 */
export function assignUnroutedJobs(
  session: WorkspaceSession,
  entry: { id: string; name: string; taggingModel: string | null },
): Promise<number> {
  return session.database.jobs.assignLane({
    type: ANALYZE_FILE_JOB,
    lane: entry.id,
    rewrite: (payload) => adoptForProvider(payload, entry),
    now: session.now().toISOString(),
  });
}

/**
 * The provider name in the newest analysis job of the lane.
 *
 * @param session the open workspace
 * @param lane the lane; null for jobs without a provider
 * @returns the name; null when there is none or it predates payload v4
 */
export async function laneName(session: WorkspaceSession, lane: string | null): Promise<string | null> {
  const payload = await session.database.jobs.latestPayloadOfLane(ANALYZE_FILE_JOB, lane);
  return payload === null ? null : analysisJobFields(payload).providerName;
}

/**
 * The waiting analysis jobs per lane, with the provider name from the lane's newest payload.
 *
 * @param session the open workspace
 * @returns one entry per lane with waiting jobs
 */
export async function listWaitingLanes(session: WorkspaceSession): Promise<WaitingLane[]> {
  const lanes = await session.database.jobs.waitingByLane(ANALYZE_FILE_JOB);
  const result: WaitingLane[] = [];
  for (const { lane, waiting } of lanes) result.push({ lane, payloadName: await laneName(session, lane), waiting });
  return result;
}

/**
 * Counts the analysis jobs of the lane in `queued`, `retry_wait`, `running` or `waiting_remote`.
 *
 * @param session the open workspace
 * @param lane the lane
 * @returns how many
 */
export function countActiveAnalysisJobs(session: WorkspaceSession, lane: string): Promise<number> {
  return session.database.jobs.countActiveInLane(ANALYZE_FILE_JOB, lane);
}
