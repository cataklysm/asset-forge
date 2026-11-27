import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SITE_DEFAULT_KINDS,
  SITE_MAX_FILES,
  SITE_MAX_PAGES,
  SITE_MIN_BYTES_MAX,
  SITE_PROFILE_NAME_MAX,
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

export const CRAWL_POLL_MS = 500;
/** Min. size is typed in KB and sent as bytes. */
export const BYTES_PER_KB = 1024;

/** The profile form as typed: numbers stay text until they are sent. */
export interface ProfileDraft {
  name: string;
  /** Only used for a new profile; an existing one keeps its site. */
  siteAddress: string;
  thumbnails: string;
  pagination: string;
  file: string;
  /** Always in the order of `FILE_KIND_OPTIONS`. */
  kinds: FileKind[];
  minKb: string;
  urlContains: string;
  maxPages: string;
  maxFiles: string;
}

const KIND_ORDER = FILE_KIND_OPTIONS.map((option) => option.kind);

/** The kinds in the order of the checkboxes, each once. */
export function orderedKinds(kinds: readonly FileKind[]): FileKind[] {
  return KIND_ORDER.filter((kind) => kinds.includes(kind));
}

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
  };
}

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
  };
}

export function sameDraft(a: ProfileDraft, b: ProfileDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function integerIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/** Bytes of a typed KB value (decimals allowed), or null when it is not a size the profile takes. */
export function bytesOfKb(text: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return null;
  const bytes = Math.round(Number(text.trim()) * BYTES_PER_KB);
  return bytes <= SITE_MIN_BYTES_MAX ? bytes : null;
}

/**
 * The `sites:save` request of a draft, or null while a field holds what the schema refuses. `id` null
 * creates a profile with the site of the typed site address; otherwise the profile keeps its site.
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
  if (minBytes === null || maxPages === null || maxFiles === null) return null;
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
  };
}

/** The answer of a test, with the saved profile and the gallery URL it ran for. */
export interface CrawlAnswer {
  profileId: string;
  url: string;
  result: SiteCrawlResult;
}

/**
 * `Import` needs a saved profile without unsaved changes and a test of exactly that profile and gallery
 * URL that found at least one file.
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

/** The line of one problem: the fixed text of its reason, filled with its detail. */
export function problemText(problem: Pick<SiteCrawlProblem, 'reason' | 'detail'>): string {
  return CRAWL_PROBLEM_TEXTS[problem.reason](problem.detail ?? '');
}

/**
 * The one line above the problems of a test that found no file, or null when it found some. Problems keep the
 * crawl's order, so the first one belongs to the first gallery page whenever that page gave nothing.
 */
export function noFilesHeadline(result: Pick<SiteCrawlResult, 'files' | 'problems' | 'cancelled'>): string | null {
  if (result.files.length > 0 || result.cancelled) return null;
  const first = result.problems[0];
  if (first === undefined) return NO_FILES_FOUND_LABEL;
  if (first.stage === 'gallery') {
    if (first.reason === 'no_thumbnails') return NO_THUMBNAILS_HEADLINE;
    if (first.reason === 'left_site') return leftSiteHeadline(first.detail ?? '');
    if (first.reason === 'http_error' && (first.detail === '401' || first.detail === '403')) return refusedPageHeadline(first.detail);
  }
  return problemText(first);
}

export interface CrawlProgressState {
  /** The last known progress; null while inactive and until the first answer that holds one. */
  progress: SiteCrawlProgress | null;
  /** True once a cancel was asked for the running crawl. */
  cancelling: boolean;
  cancel(): void;
}

/**
 * While `active` (the dialog's `sites:crawl` call is pending), asks `sites:crawlProgress` every
 * `CRAWL_POLL_MS`, one request at a time. A failed request keeps the last value; inactive resets.
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
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function poll() {
      timer = null;
      call('sites:crawlProgress', {})
        .then(
          (next) => {
            if (!disposed) setProgress(next);
          },
          // The last value stays; the next tick asks again.
          () => {},
        )
        .finally(() => {
          if (!disposed) timer = setTimeout(poll, CRAWL_POLL_MS);
        });
    }
    timer = setTimeout(poll, CRAWL_POLL_MS);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
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

  return { progress: active ? progress : null, cancelling: active && (cancelling || progress?.cancelling === true), cancel };
}
