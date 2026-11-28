import {
  FILE_DOWNLOAD_JOB,
  IMPORT_URL_LINE_MAX,
  type FileDownloadPayload,
  type FileTarget,
  type SiteFilter,
  type UrlImportResult,
} from '@assetforge/contracts';
import { normalizeDownloadUrl } from './download-url.js';
import type { NewJob } from './jobs.js';
import { requireAsset } from './require-asset.js';
import type { WorkspaceSession } from './session.js';

/** The text of an invalid line in the answer. */
const INVALID_TEXT_MAX = 200;

/** What `enqueueUrlImport` queues. */
export interface UrlImportRequest {
  urls: readonly string[];
  target: FileTarget | null;
  skipDuplicates: boolean;
  /**
   * A site import: the jobs go out with this profile's login and keep only what passes `filter` (payload v2).
   * They all share the lane `site` (the profile's site), whatever host a file is on, so the host limits them as
   * one queue.
   */
  site?: { profileId: string; site: string; filter: SiteFilter };
}

/**
 * Queues one `file.download` job per usable URL, all in one transaction. Blank lines are skipped and not counted;
 * a URL a complete file already carries (trash included) is `alreadyImported`; a repeat within the call or a URL
 * with an active job is `alreadyQueued`. An unknown target asset answers `not_found` and queues nothing.
 * The caller wakes the scheduler.
 *
 * @param session the open workspace
 * @param request the lines, the target, the duplicate rule and for a site import its profile
 * @returns the counts and the invalid lines
 * @throws NotFoundError for an unknown target asset
 */
export async function enqueueUrlImport(session: WorkspaceSession, request: UrlImportRequest): Promise<UrlImportResult> {
  if (request.target !== null) await requireAsset(session, request.target.assetId);
  const result: UrlImportResult = { queued: 0, alreadyImported: 0, alreadyQueued: 0, invalid: [] };

  const usable = usableUrls(request.urls, result);
  if (usable.length === 0) return result;

  const known = await session.database.fileOrigins.knownUrls(usable);
  const jobs: NewJob[] = [];
  for (const url of usable) {
    if (known.has(url)) {
      result.alreadyImported++;
      continue;
    }
    jobs.push(downloadJob(session, url, request));
  }
  if (jobs.length === 0) return result;
  const inserted = await session.database.jobs.enqueue({ jobs, now: session.now().toISOString() });
  result.queued = inserted.length;
  result.alreadyQueued += jobs.length - inserted.length;
  return result;
}

/**
 * The normalised URLs of the lines, each once; counts repeats and collects the invalid lines in `result`.
 *
 * @param lines the lines as sent
 * @param result collects the repeats and the invalid lines
 * @returns the usable URLs in line order
 */
function usableUrls(lines: readonly string[], result: UrlImportResult): string[] {
  const seen = new Set<string>();
  const usable: string[] = [];
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === '') return;
    const url = lineUrl(text);
    if (url === null) {
      result.invalid.push({ line: index + 1, text: text.slice(0, INVALID_TEXT_MAX) });
      return;
    }
    if (seen.has(url)) {
      result.alreadyQueued++;
      return;
    }
    seen.add(url);
    usable.push(url);
  });
  return usable;
}

/**
 * The URL of one trimmed line.
 *
 * @param text the trimmed line
 * @returns the normalised URL; null for a line that is too long or no usable URL
 */
function lineUrl(text: string): string | null {
  // Measured after the trim: surrounding spaces never make a line too long.
  if (text.length > IMPORT_URL_LINE_MAX) return null;
  try {
    return normalizeDownloadUrl(text);
  } catch {
    return null;
  }
}

/**
 * The download job of one URL: payload v1, or v2 for a site import, in the lane of the host or the site.
 *
 * @param session the open workspace
 * @param url the normalised URL
 * @param request the target, the duplicate rule and for a site import its profile
 * @returns the new job
 */
function downloadJob(session: WorkspaceSession, url: string, request: UrlImportRequest): NewJob {
  const fields = { url, target: request.target, skipDuplicates: request.skipDuplicates };
  const { site } = request;
  const payload: FileDownloadPayload =
    site === undefined
      ? { v: 1, ...fields }
      : {
          v: 2,
          ...fields,
          siteProfileId: site.profileId,
          filter: { kinds: [...site.filter.kinds], minBytes: site.filter.minBytes },
        };
  return {
    id: session.newId(),
    type: FILE_DOWNLOAD_JOB,
    resourceClass: 'io',
    fileId: null,
    lane: site?.site ?? new URL(url).host,
    payload,
    dedupeKey: `url:${url}`,
  };
}
