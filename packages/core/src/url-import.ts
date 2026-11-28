import {
  FILE_DOWNLOAD_JOB,
  IMPORT_URL_LINE_MAX,
  type FileDownloadPayload,
  type FileTarget,
  type SiteFilter,
  type UrlImportResult,
} from '@assetforge/contracts';
import { normalizeSourceUrl } from './asset-sources.js';
import type { NewJob } from './jobs.js';
import type { WorkspaceSession } from './session.js';
import { requireAsset } from './tags.js';

/** The text of an invalid line in the answer. */
const INVALID_TEXT_MAX = 200;

/**
 * The URL rule of the import: the rule of asset sources (`normalizeSourceUrl`), then the fragment dropped,
 * since it is never sent. The answer is the identity of a URL everywhere. Throws `validation_failed`.
 */
export function normalizeDownloadUrl(input: string): string {
  const url = new URL(normalizeSourceUrl(input));
  url.hash = '';
  return url.href;
}

/**
 * Queues one `file.download` job per usable URL, all in one transaction. Blank lines are skipped and not counted;
 * a URL a complete file already carries (trash included) is `alreadyImported`; a repeat within the call or a URL
 * with an active job is `alreadyQueued`. An unknown target asset answers `not_found` and queues nothing.
 * The caller wakes the scheduler.
 */
export async function enqueueUrlImport(
  s: WorkspaceSession,
  r: {
    urls: readonly string[];
    target: FileTarget | null;
    skipDuplicates: boolean;
    /**
     * A site import: the jobs go out with this profile's login and keep only what passes `filter` (payload v2).
     * They all share the lane `site` (the profile's site), whatever host a file is on, so the host limits them as
     * one queue.
     */
    site?: { profileId: string; site: string; filter: SiteFilter };
  },
): Promise<UrlImportResult> {
  if (r.target !== null) await requireAsset(s, r.target.assetId);
  const result: UrlImportResult = { queued: 0, alreadyImported: 0, alreadyQueued: 0, invalid: [] };

  const seen = new Set<string>();
  const usable: string[] = [];
  r.urls.forEach((line, index) => {
    const text = line.trim();
    if (text === '') return;
    let url: string;
    try {
      // Measured after the trim: surrounding spaces never make a line too long.
      if (text.length > IMPORT_URL_LINE_MAX) throw new Error('too long');
      url = normalizeDownloadUrl(text);
    } catch {
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
  if (usable.length === 0) return result;

  const known = await s.database.fileOrigins.knownUrls(usable);
  const jobs: NewJob[] = [];
  for (const url of usable) {
    if (known.has(url)) {
      result.alreadyImported++;
      continue;
    }
    const fields = { url, target: r.target, skipDuplicates: r.skipDuplicates };
    const payload: FileDownloadPayload =
      r.site === undefined
        ? { v: 1, ...fields }
        : { v: 2, ...fields, siteProfileId: r.site.profileId, filter: { kinds: [...r.site.filter.kinds], minBytes: r.site.filter.minBytes } };
    jobs.push({
      id: s.newId(),
      type: FILE_DOWNLOAD_JOB,
      resourceClass: 'io',
      fileId: null,
      lane: r.site?.site ?? new URL(url).host,
      payload,
      dedupeKey: `url:${url}`,
    });
  }
  if (jobs.length === 0) return result;
  const inserted = await s.database.jobs.enqueue({ jobs, now: s.now().toISOString() });
  result.queued = inserted.length;
  result.alreadyQueued += jobs.length - inserted.length;
  return result;
}
