import { FILE_DOWNLOAD_JOB } from '@assetforge/contracts';
import type { Job } from './jobs.js';
import type { WorkspaceSession } from './session.js';

/**
 * The failed downloads of one lane that a site's browser check refused (`download_browser_check`).
 *
 * @param session the open workspace
 * @param lane the download lane, for a site profile its site
 * @returns the jobs, oldest first
 */
export async function browserCheckFailures(session: WorkspaceSession, lane: string): Promise<Job[]> {
  return (await session.database.jobs.listByStatus('failed')).filter(
    (job) => job.type === FILE_DOWNLOAD_JOB && job.lane === lane && job.errorCode === 'download_browser_check',
  );
}

/**
 * Queues the downloads of one lane that a browser check refused once more, after the owner passed the check by hand.
 * A job whose URL another active job already holds stays failed.
 *
 * @param session the open workspace
 * @param lane the download lane, for a site profile its site
 * @returns how many jobs were queued
 */
export async function retryBrowserCheckFailures(session: WorkspaceSession, lane: string): Promise<number> {
  let queued = 0;
  for (const job of await browserCheckFailures(session, lane)) {
    queued += await session.database.jobs.retry({ id: job.id, now: session.now().toISOString() });
  }
  return queued;
}
