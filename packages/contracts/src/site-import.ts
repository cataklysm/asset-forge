import { z } from 'zod';
import { FileKindSchema, FileTargetSchema } from './files';
import { JobErrorCodeSchema } from './job-errors';
import { CountSchema, IdSchema } from './ipc-shared';

/** At most this many site profiles at app level. */
export const MAX_SITE_PROFILES = 50;
/** The longest XPath expression of a profile. */
export const SITE_XPATH_MAX = 1000;
/** The longest `urlContains` text of a profile. */
export const SITE_URL_CONTAINS_MAX = 200;
/** Gallery pages one crawl may load. */
export const SITE_MAX_PAGES = { min: 1, max: 200, default: 20 };
/** File URLs one crawl may answer. */
export const SITE_MAX_FILES = { min: 1, max: 5000, default: 1000 };
/** Independent browser pages used to resolve gallery details. */
export const SITE_DETAIL_CONCURRENCY = { min: 1, max: 6, default: 3 };
/** Minimum interval between page-request starts for a site, in milliseconds. */
export const SITE_REQUEST_GAP_MS = { min: 0, max: 10_000, default: 500 };
/** Overall deadline of one browser page, in milliseconds. */
export const SITE_PAGE_TIMEOUT_MS = { min: 5_000, max: 120_000, default: 30_000 };
/** The longest profile name. */
export const SITE_PROFILE_NAME_MAX = 60;
/** The kinds a new profile wants. */
export const SITE_DEFAULT_KINDS = ['image', 'video'] as const;
/** The largest `minBytes`: the download limit of the URL import (500 MiB). */
export const SITE_MIN_BYTES_MAX = 500 * 1024 * 1024;

/** Which downloaded files a site import keeps: a kind in `kinds` and at least `minBytes`. */
export const SiteFilterSchema = z.object({
  kinds: z
    .array(FileKindSchema)
    .min(1)
    .max(FileKindSchema.options.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, { message: 'The kinds must be distinct' }),
  minBytes: z.number().int().min(0).max(SITE_MIN_BYTES_MAX),
});
/** Which downloaded files a site import keeps. */
export type SiteFilter = z.infer<typeof SiteFilterSchema>;

/** The fields a stored profile and a save request share. */
const profileFields = {
  name: z.string().trim().min(1).max(SITE_PROFILE_NAME_MAX),
  /** Selects the gallery's links. */
  thumbnails: z.string().min(1).max(SITE_XPATH_MAX),
  /** Empty: the gallery has one page. */
  pagination: z.string().max(SITE_XPATH_MAX),
  /** Empty: a thumbnail link is the file itself. */
  file: z.string().max(SITE_XPATH_MAX),
  kinds: SiteFilterSchema.shape.kinds,
  minBytes: SiteFilterSchema.shape.minBytes,
  /** When set, a file URL must contain it, regardless of case. */
  urlContains: z.string().max(SITE_URL_CONTAINS_MAX),
  maxPages: z.number().int().min(SITE_MAX_PAGES.min).max(SITE_MAX_PAGES.max),
  maxFiles: z.number().int().min(SITE_MAX_FILES.min).max(SITE_MAX_FILES.max),
  detailConcurrency: z.number().int().min(SITE_DETAIL_CONCURRENCY.min).max(SITE_DETAIL_CONCURRENCY.max).optional(),
  requestGapMs: z.number().int().min(SITE_REQUEST_GAP_MS.min).max(SITE_REQUEST_GAP_MS.max).optional(),
  pageTimeoutMs: z.number().int().min(SITE_PAGE_TIMEOUT_MS.min).max(SITE_PAGE_TIMEOUT_MS.max).optional(),
};

/** A site profile; `site` is taken from the URL typed at creation (`siteOf`) and never changes. */
export const SiteProfileSchema = z.object({
  id: IdSchema,
  site: z.string().min(1).max(253),
  ...profileFields,
});
/** A site profile. */
export type SiteProfile = z.infer<typeof SiteProfileSchema>;

/** Without `id` a profile is created and `url` gives its site; with `id` it is replaced and its site stays. */
export const SaveSiteProfileSchema = z
  .object({
    id: IdSchema.optional(),
    url: z.string().max(2000).optional(),
    ...profileFields,
  })
  .refine((profile) => profile.id !== undefined || profile.url !== undefined, {
    message: 'A new profile needs a URL',
    path: ['url'],
  });
/** The request of `sites:save`. */
export type SaveSiteProfile = z.infer<typeof SaveSiteProfileSchema>;

/** At most this many problems one crawl answers; the rest is only counted (`problemsDropped`). */
export const SITE_MAX_PROBLEMS = 200;
/** The longest found value an `invalid_link` problem repeats. */
export const SITE_PROBLEM_VALUE_MAX = 200;

/**
 * What the URL of a problem was meant to be: a gallery page, a detail page, a file, or (`link`) a value found on
 * a page that never became a usable URL; the problem's `url` is then the page it was found on.
 */
export const SiteCrawlStageSchema = z.enum(['gallery', 'detail', 'file', 'link']);
/** What the URL of a crawl problem was meant to be. */
export type SiteCrawlStage = z.infer<typeof SiteCrawlStageSchema>;

/**
 * Why a page or a URL gave nothing. `detail` carries the host for `left_site` and `robots_unavailable` (empty when
 * unknown), the status as text for `http_error`, the value cut to SITE_PROBLEM_VALUE_MAX for `invalid_link`, and
 * null otherwise.
 */
export const SiteCrawlProblemReasonSchema = z.enum([
  'no_thumbnails',
  'no_file',
  'timeout',
  'left_site',
  'http_error',
  'load_failed',
  'robots_disallowed',
  'robots_unavailable',
  'invalid_link',
  'off_site',
  'filtered_kind',
  'filtered_text',
]);
/** Why a page or a URL gave nothing. */
export type SiteCrawlProblemReason = z.infer<typeof SiteCrawlProblemReasonSchema>;

/** One reason a page or URL of a crawl gave nothing. */
export const SiteCrawlProblemSchema = z.object({
  url: z.string().max(10_000),
  stage: SiteCrawlStageSchema,
  reason: SiteCrawlProblemReasonSchema,
  detail: z.string().max(253).nullable(),
});
/** One reason a page or URL of a crawl gave nothing. */
export type SiteCrawlProblem = z.infer<typeof SiteCrawlProblemSchema>;

/**
 * What a crawl found; nothing is downloaded until `sites:import` names `crawlId`. `problems` names, in the order
 * they arose, why pages or URLs gave nothing (each distinct problem once); `problemsDropped` counts those that did
 * not fit.
 */
export const SiteCrawlResultSchema = z.object({
  crawlId: IdSchema,
  files: z.array(z.string()).max(SITE_MAX_FILES.max),
  pages: CountSchema,
  duplicates: CountSchema,
  filtered: CountSchema,
  disallowed: CountSchema,
  invalid: CountSchema,
  /** Distinct pagination and detail links off the site, each counted once. */
  offSite: CountSchema,
  pageFailures: CountSchema,
  truncated: z.enum(['pages', 'files']).nullable(),
  cancelled: z.boolean(),
  problems: z.array(SiteCrawlProblemSchema).max(SITE_MAX_PROBLEMS),
  problemsDropped: CountSchema,
});
/** The answer of `sites:crawl`. */
export type SiteCrawlResult = z.infer<typeof SiteCrawlResultSchema>;

/** The progress of the running crawl: pages loaded and file URLs found so far. */
export const SiteCrawlProgressSchema = z.object({ pages: CountSchema, files: CountSchema, cancelling: z.boolean() });
/** The progress of the running crawl. */
export type SiteCrawlProgress = z.infer<typeof SiteCrawlProgressSchema>;

/** A discovered URL with its review-time asset-scoped filename match. */
export const SiteImportCandidateSchema = z.object({
  url: z.string().max(10_000),
  sourcePageUrl: z.string().max(10_000),
  expectedName: z.string().nullable(),
  alreadyPresent: z.boolean(),
});
/** A discovered URL, retained even when an optional review filter excludes it. */
export type SiteImportCandidate = z.infer<typeof SiteImportCandidateSchema>;

/** A durable discovery task as shown by the site-import review UI. */
export const SiteCrawlDownloadsSchema = z.object({
  total: CountSchema,
  queued: CountSchema,
  running: CountSchema,
  waiting: CountSchema,
  succeeded: CountSchema,
  failed: CountSchema,
  cancelled: CountSchema,
});
/** Download outcomes retained independently of the technical job history. */
export type SiteCrawlDownloads = z.infer<typeof SiteCrawlDownloadsSchema>;

/** A durable discovery task as shown by the site-import review UI. */
export const SiteCrawlTaskSchema = z.object({
  crawlId: IdSchema,
  jobId: IdSchema,
  profileId: IdSchema,
  profileName: z.string(),
  site: z.string(),
  galleryUrl: z.string().max(2000),
  target: FileTargetSchema.nullable(),
  targetAssetName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  status: z.enum([
    'queued',
    'running',
    'waiting',
    'ready',
    'failed',
    'cancelled',
    'imported',
    'completed',
    'import_failed',
  ]),
  /** Null for pre-tracking imports and tasks that have not imported anything. */
  downloads: SiteCrawlDownloadsSchema.nullable().optional(),
  errorCode: JobErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  progress: SiteCrawlProgressSchema,
  result: SiteCrawlResultSchema.nullable(),
  candidates: z.array(SiteImportCandidateSchema).max(SITE_MAX_FILES.max),
});
/** A persisted crawl with technical progress and independently reviewable results. */
export type SiteCrawlTask = z.infer<typeof SiteCrawlTaskSchema>;
/** Lightweight polling list; full candidate arrays are fetched only for the selected task. */
export const SiteCrawlTaskSummarySchema = SiteCrawlTaskSchema.omit({ result: true, candidates: true });
/** Queue summary without result and candidate arrays. */
export type SiteCrawlTaskSummary = z.infer<typeof SiteCrawlTaskSummarySchema>;

/** Job type of gallery discovery; downloads are explicitly queued after review. */
export const SITE_CRAWL_JOB = 'site.crawl';
