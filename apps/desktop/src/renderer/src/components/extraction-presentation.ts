import type { SiteCrawlTaskSummary } from '@assetforge/contracts';
import { SITE_INBOX_TARGET_LABEL } from '../labels';

/** @param task captured destination @returns its asset and role, or Inbox */
export function crawlTargetLabel(task: Pick<SiteCrawlTaskSummary, 'target' | 'targetAssetName'>): string {
  return task.target === null ? SITE_INBOX_TARGET_LABEL : `${task.targetAssetName ?? 'Asset'} · ${task.target.role}`;
}

/**
 * Gives an extraction a recognizable gallery name instead of repeating its generic profile name.
 * @param task gallery and profile
 * @returns gallery slug or site/profile fallback
 */
export function extractionTitle(task: SiteCrawlTaskSummary): string {
  try {
    const url = new URL(task.galleryUrl);
    const segment = url.pathname.split('/').filter(Boolean).at(-1);
    if (segment !== undefined && !segment.includes('.'))
      return decodeURIComponent(segment).replace(/[-_]+/g, ' ').slice(0, 80);
    return task.profileName;
  } catch {
    return task.profileName;
  }
}

/**
 * The current phase in plain language; older imports never pretend their untracked downloads finished.
 * @param task persisted extraction and optional import counters
 * @returns short status text
 */
export function extractionStatus(task: SiteCrawlTaskSummary): string {
  switch (task.status) {
    case 'imported':
      return task.downloads == null ? 'Import submitted' : 'Importing';
    case 'completed':
      return 'Completed';
    case 'import_failed':
      return 'Needs attention';
    case 'ready':
      return 'Ready to import';
    case 'running':
      return 'Extracting';
    case 'queued':
      return 'Queued';
    case 'waiting':
      return 'Waiting';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Extraction failed';
  }
}

/**
 * Download progress uses all settled outcomes; failures remain visibly distinct from successful completion.
 * @param task tracked download counts
 * @returns settled count or null before tracking
 */
export function processedDownloads(task: SiteCrawlTaskSummary): number | null {
  const downloads = task.downloads;
  return downloads == null ? null : downloads.succeeded + downloads.failed + downloads.cancelled;
}
