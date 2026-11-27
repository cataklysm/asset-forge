import {
  FILE_DOWNLOAD_JOB,
  IMPORT_URL_LINE_MAX,
  type FileDownloadPayload,
  type FileOrigin,
  type FileTarget,
  type UrlImportResult,
} from '@assetforge/contracts';
import { normalizeSourceUrl } from './asset-sources.js';
import { NotFoundError } from './errors.js';
import type { NewJob } from './jobs.js';
import type { WorkspaceSession } from './session.js';
import { requireAsset } from './tags.js';

/** The largest file one download stores (500 MiB). */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** How long a download waits for the response headers. */
export const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000;
/** How long a download waits without receiving data. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** How long one download may take in total (30 min). */
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 1_800_000;
/** How many redirects one download follows. */
export const MAX_DOWNLOAD_REDIRECTS = 5;
/** The free space a download leaves on the storage volume beyond the announced length (2 GiB). */
export const DOWNLOAD_FREE_SPACE_RESERVE = 2 * 1024 ** 3;
/** Bounds and default of the wait a throttled download takes. */
export const RETRY_AFTER_MIN_MS = 5_000;
export const RETRY_AFTER_MAX_MS = 900_000;
export const RETRY_AFTER_DEFAULT_MS = 60_000;

/** The wait of a throttled download: the server's wait clamped to 5 s – 15 min, 60 s when it gave none. */
export function clampRetryAfterMs(ms: number | null): number {
  if (ms === null || Number.isNaN(ms)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

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
  r: { urls: readonly string[]; target: FileTarget | null; skipDuplicates: boolean },
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
    const payload: FileDownloadPayload = { v: 1, url, target: r.target, skipDuplicates: r.skipDuplicates };
    jobs.push({
      id: s.newId(),
      type: FILE_DOWNLOAD_JOB,
      resourceClass: 'io',
      fileId: null,
      lane: new URL(url).host,
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

/** The addresses a file was downloaded from, oldest first; an unknown file answers `not_found`. */
export async function listFileOrigins(s: WorkspaceSession, fileId: string): Promise<FileOrigin[]> {
  if ((await s.database.files.get(fileId)) === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return s.database.fileOrigins.listByFile(fileId);
}

/** The stored URL of an origin of the file, checked by the URL rule again before it is handed out. */
export async function resolveFileOriginUrl(s: WorkspaceSession, r: { fileId: string; originId: string }): Promise<string> {
  const origin = await s.database.fileOrigins.get(r.originId);
  if (origin === null || origin.fileId !== r.fileId) throw new NotFoundError('Origin does not exist');
  return normalizeDownloadUrl(origin.url);
}
