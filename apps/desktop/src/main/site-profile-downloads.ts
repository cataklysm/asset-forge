import { belongsToSite, FILE_DOWNLOAD_JOB, FileDownloadPayloadSchema, type JobStatus, type SiteProfile } from '@assetforge/contracts';
import { browserCheckFailures, type WorkspaceSession } from '@assetforge/core';

// What the open workspace holds about the downloads of one site profile.

const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting_remote', 'retry_wait'];

/**
 * Whether the open workspace has a queued, waiting or running download of this profile.
 *
 * @param session the open workspace
 * @param profileId the profile's id
 * @returns true when one v2 download of the profile is active
 */
export async function hasActiveDownloads(session: WorkspaceSession, profileId: string): Promise<boolean> {
  for (const status of ACTIVE_STATUSES) {
    for (const job of await session.database.jobs.listByStatus(status)) {
      if (job.type !== FILE_DOWNLOAD_JOB) continue;
      const payload = FileDownloadPayloadSchema.safeParse(job.payload);
      if (payload.success && payload.data.v === 2 && payload.data.siteProfileId === profileId) return true;
    }
  }
  return false;
}

/**
 * The URL of the newest download of the profile's lane that a browser check refused, where the owner passes the check.
 * Only a v2 payload of this profile whose URL belongs to its site counts.
 *
 * @param session the open workspace
 * @param profile the profile whose site is the lane
 * @returns the URL, or null when no such download exists
 */
export async function refusedDownloadUrl(session: WorkspaceSession, profile: SiteProfile): Promise<string | null> {
  // Newest refusal first: by the end of the failed run, then by creation.
  const failures = (await browserCheckFailures(session, profile.site)).sort(
    (left, right) =>
      (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt) ||
      right.createdAt.localeCompare(left.createdAt),
  );
  for (const job of failures) {
    const payload = FileDownloadPayloadSchema.safeParse(job.payload);
    if (!payload.success || payload.data.v !== 2 || payload.data.siteProfileId !== profile.id) continue;
    if (belongsToSite(payload.data.url, profile.site)) return payload.data.url;
  }
  return null;
}
