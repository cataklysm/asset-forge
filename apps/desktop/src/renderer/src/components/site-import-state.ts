import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SITE_DEFAULT_KINDS,
  SITE_DETAIL_CONCURRENCY,
  SITE_MAX_FILES,
  SITE_MAX_PAGES,
  SITE_MIN_BYTES_MAX,
  SITE_PROFILE_NAME_MAX,
  SITE_PAGE_TIMEOUT_MS,
  SITE_REQUEST_GAP_MS,
  SITE_URL_CONTAINS_MAX,
  SITE_XPATH_MAX,
  type FileKind,
  type SaveSiteProfile,
  type SiteCrawlProblem,
  type SiteCrawlProgress,
  type SiteCrawlResult,
  type SiteProfile,
} from '@assetforge/contracts';
import { call } from '../api';
import {
  CRAWL_PROBLEM_TEXTS,
  FILE_KIND_OPTIONS,
  leftSiteHeadline,
  NO_FILES_FOUND_LABEL,
  NO_THUMBNAILS_HEADLINE,
  refusedPageHeadline,
} from '../labels';
import { startPolling } from '../poller';

// The state of the site import dialog: the profile draft and its save request, the test's answer, and the
// crawl progress polled while a test runs.

/** How often the progress is asked for while a test runs. */
export const CRAWL_POLL_MS = 500;
/** Min. size is typed in KB and sent as bytes. */
export const BYTES_PER_KB = 1024;

/** The profile form as typed: numbers stay text until they are sent. */
export interface ProfileDraft {
  /** The profile's name. */
  name: string;
  /** Only used for a new profile; an existing one keeps its site. */
  siteAddress: string;
  /** The XPath of the thumbnails on a gallery page. */
  thumbnails: string;
  /** The XPath of the next gallery page; empty for one page. */
  pagination: string;
  /** The XPath of the file on a detail page; empty when the thumbnail links the file. */
  file: string;
  /** Always in the order of `FILE_KIND_OPTIONS`. */
  kinds: FileKind[];
  /** The minimum size in KB. */
  minKb: string;
  /** Text a file URL must contain; empty for any. */
  urlContains: string;
  /** The most gallery pages read. */
  maxPages: string;
  /** The most files found. */
  maxFiles: string;
  /** The number of independently loaded detail pages. */
  detailConcurrency: string;
  /** The minimum time between page-request starts. */
  requestGapMs: string;
  /** Maximum page-load duration, typed in seconds. */
  pageTimeoutSeconds: string;
}

const KIND_ORDER = FILE_KIND_OPTIONS.map((option) => option.kind);

/**
 * The kinds in the order of the checkboxes, each once.
 *
 * @param kinds the kinds in any order
 * @returns the kinds in checkbox order
 */
export function orderedKinds(kinds: readonly FileKind[]): FileKind[] {
  return KIND_ORDER.filter((kind) => kinds.includes(kind));
}

/**
 * The form of a new profile.
 *
 * @returns empty texts, the default kinds and the default limits
 */
export function newDraft(): ProfileDraft {
  return {
    name: '',
    siteAddress: '',
    thumbnails: '',
    pagination: '',
    file: '',
    kinds: orderedKinds(SITE_DEFAULT_KINDS),
    minKb: '0',
    urlContains: '',
    maxPages: String(SITE_MAX_PAGES.default),
    maxFiles: String(SITE_MAX_FILES.default),
    detailConcurrency: String(SITE_DETAIL_CONCURRENCY.default),
    requestGapMs: String(SITE_REQUEST_GAP_MS.default),
    pageTimeoutSeconds: String(SITE_PAGE_TIMEOUT_MS.default / 1000),
  };
}

/**
 * The form of a saved profile.
 *
 * @param profile the profile
 * @returns its fields as text
 */
export function draftOf(profile: SiteProfile): ProfileDraft {
  return {
    name: profile.name,
    siteAddress: '',
    thumbnails: profile.thumbnails,
    pagination: profile.pagination,
    file: profile.file,
    kinds: orderedKinds(profile.kinds),
    minKb: String(profile.minBytes / BYTES_PER_KB),
    urlContains: profile.urlContains,
    maxPages: String(profile.maxPages),
    maxFiles: String(profile.maxFiles),
    detailConcurrency: String(profile.detailConcurrency ?? SITE_DETAIL_CONCURRENCY.default),
    requestGapMs: String(profile.requestGapMs ?? SITE_REQUEST_GAP_MS.default),
    pageTimeoutSeconds: String((profile.pageTimeoutMs ?? SITE_PAGE_TIMEOUT_MS.default) / 1000),
  };
}

/**
 * Whether two forms hold the same values.
 *
 * @param first one form
 * @param second the other form
 * @returns true when every field is equal
 */
export function sameDraft(first: ProfileDraft, second: ProfileDraft): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * A typed whole number within bounds.
 *
 * @param text the typed text
 * @param min the least value taken
 * @param max the greatest value taken
 * @returns the number, or null when the text is no whole number within the bounds
 */
function integerIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/**
 * Bytes of a typed KB value (decimals allowed).
 *
 * @param text the typed value
 * @returns the bytes, or null when it is not a size the profile takes
 */
export function bytesOfKb(text: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return null;
  const bytes = Math.round(Number(text.trim()) * BYTES_PER_KB);
  return bytes <= SITE_MIN_BYTES_MAX ? bytes : null;
}

/**
 * The `sites:save` request of a draft, or null while a field holds what the schema refuses. `id` null
 * creates a profile with the site of the typed site address; otherwise the profile keeps its site.
 *
 * @param draft the form
 * @param id the saved profile's id; null for a new one
 * @returns the request, or null while the form cannot be saved
 */
export function saveRequestOf(draft: ProfileDraft, id: string | null): SaveSiteProfile | null {
  const name = draft.name.trim();
  if (name === '' || name.length > SITE_PROFILE_NAME_MAX) return null;
  if (draft.thumbnails.trim() === '' || draft.thumbnails.length > SITE_XPATH_MAX) return null;
  if (draft.pagination.length > SITE_XPATH_MAX || draft.file.length > SITE_XPATH_MAX) return null;
  if (draft.urlContains.length > SITE_URL_CONTAINS_MAX) return null;
  if (draft.kinds.length === 0) return null;
  const minBytes = bytesOfKb(draft.minKb);
  const maxPages = integerIn(draft.maxPages, SITE_MAX_PAGES.min, SITE_MAX_PAGES.max);
  const maxFiles = integerIn(draft.maxFiles, SITE_MAX_FILES.min, SITE_MAX_FILES.max);
  const detailConcurrency = integerIn(
    draft.detailConcurrency,
    SITE_DETAIL_CONCURRENCY.min,
    SITE_DETAIL_CONCURRENCY.max,
  );
  const requestGapMs = integerIn(draft.requestGapMs, SITE_REQUEST_GAP_MS.min, SITE_REQUEST_GAP_MS.max);
  const pageTimeoutSeconds = integerIn(
    draft.pageTimeoutSeconds,
    SITE_PAGE_TIMEOUT_MS.min / 1000,
    SITE_PAGE_TIMEOUT_MS.max / 1000,
  );
  if (minBytes === null || maxPages === null || maxFiles === null) return null;
  if (detailConcurrency === null || requestGapMs === null || pageTimeoutSeconds === null) return null;
  const site = draft.siteAddress.trim();
  if (id === null && (site === '' || site.length > 2000)) return null;
  return {
    ...(id === null ? { url: site } : { id }),
    name,
    thumbnails: draft.thumbnails,
    pagination: draft.pagination,
    file: draft.file,
    kinds: orderedKinds(draft.kinds),
    minBytes,
    urlContains: draft.urlContains,
    maxPages,
    maxFiles,
    detailConcurrency,
    requestGapMs,
    pageTimeoutMs: pageTimeoutSeconds * 1000,
  };
}

/** The answer of a test, with the saved profile and the gallery URL it ran for. */
export interface CrawlAnswer {
  /** The tested profile. */
  profileId: string;
  /** The gallery URL as typed when the test started. */
  url: string;
  /** The crawl's answer. */
  result: SiteCrawlResult;
}

/**
 * `Import` needs a saved profile without unsaved changes and a test of exactly that profile and gallery
 * URL that found at least one file.
 *
 * @param crawl the last test's answer
 * @param profileId the selected saved profile; null for a new one
 * @param dirty whether the form has unsaved changes
 * @param url the gallery URL as typed now
 * @returns whether Import may start
 */
export function canImport(crawl: CrawlAnswer | null, profileId: string | null, dirty: boolean, url: string): boolean {
  return (
    crawl !== null &&
    profileId !== null &&
    !dirty &&
    crawl.profileId === profileId &&
    crawl.url === url &&
    crawl.result.files.length > 0
  );
}

/**
 * The line of one problem: the fixed text of its reason, filled with its detail.
 *
 * @param problem the problem's reason and detail
 * @returns the line
 */
export function problemText(problem: Pick<SiteCrawlProblem, 'reason' | 'detail'>): string {
  return CRAWL_PROBLEM_TEXTS[problem.reason](problem.detail ?? '');
}

/**
 * The one line above the problems of a test that found no file, or null when it found some. Problems keep the
 * crawl's order, so the first one belongs to the first gallery page whenever that page gave nothing.
 *
 * @param result the test's files, problems and whether it was cancelled
 * @returns the headline, or null
 */
export function noFilesHeadline(result: Pick<SiteCrawlResult, 'files' | 'problems' | 'cancelled'>): string | null {
  if (result.files.length > 0 || result.cancelled) return null;
  const first = result.problems[0];
  if (first === undefined) return NO_FILES_FOUND_LABEL;
  if (first.stage === 'gallery') {
    if (first.reason === 'no_thumbnails') return NO_THUMBNAILS_HEADLINE;
    if (first.reason === 'left_site') return leftSiteHeadline(first.detail ?? '');
    if (first.reason === 'http_error' && (first.detail === '401' || first.detail === '403'))
      return refusedPageHeadline(first.detail);
  }
  return problemText(first);
}

/** What the dialog shows of a running test. */
export interface CrawlProgressState {
  /** The last known progress; null while inactive and until the first answer that holds one. */
  progress: SiteCrawlProgress | null;
  /** True once a cancel was asked for the running crawl. */
  cancelling: boolean;
  /** Asks the main process to stop the running crawl. */
  cancel(): void;
}

/**
 * While `active` (the dialog's `sites:crawl` call is pending), asks `sites:crawlProgress` every
 * `CRAWL_POLL_MS`, one request at a time. A failed request keeps the last value; inactive resets.
 *
 * @param active whether the dialog's crawl call is pending
 * @returns the progress, whether a cancel was asked, and the cancel
 */
export function useCrawlProgress(active: boolean): CrawlProgressState {
  const [progress, setProgress] = useState<SiteCrawlProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const run = useRef({ active, id: 0 });

  useEffect(() => {
    run.current = { active, id: run.current.id + 1 };
    setCancelling(false);
    if (!active) {
      setProgress(null);
      return;
    }
    // A failed request keeps the last value; the next tick asks again.
    return startPolling(() => call('sites:crawlProgress', {}), setProgress, CRAWL_POLL_MS);
  }, [active]);

  const cancel = useCallback(() => {
    if (!run.current.active) return;
    const id = run.current.id;
    setCancelling(true);
    const refused = () => {
      if (run.current.id === id) setCancelling(false);
    };
    call('sites:cancelCrawl', {}).then(({ cancelling: accepted }) => {
      if (!accepted) refused();
    }, refused);
  }, []);

  return {
    progress: active ? progress : null,
    cancelling: active && (cancelling || progress?.cancelling === true),
    cancel,
  };
}
