import { z } from 'zod';
import { FileKindSchema } from './files';

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
/** The longest profile name. */
export const SITE_PROFILE_NAME_MAX = 60;
/** The kinds a new profile wants. */
export const SITE_DEFAULT_KINDS = ['image', 'video'] as const;
/** The largest `minBytes`: the download limit of the URL import (500 MiB). */
export const SITE_MIN_BYTES_MAX = 500 * 1024 * 1024;

const count = z.number().int().nonnegative();

/** Which downloaded files a site import keeps: a kind in `kinds` and at least `minBytes`. */
export const SiteFilterSchema = z.object({
  kinds: z
    .array(FileKindSchema)
    .min(1)
    .max(FileKindSchema.options.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, { message: 'The kinds must be distinct' }),
  minBytes: z.number().int().min(0).max(SITE_MIN_BYTES_MAX),
});
export type SiteFilter = z.infer<typeof SiteFilterSchema>;

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
};

/** A site profile; `site` is taken from the URL typed at creation (`siteOf`) and never changes. */
export const SiteProfileSchema = z.object({
  id: z.uuid(),
  site: z.string().min(1).max(253),
  ...profileFields,
});
export type SiteProfile = z.infer<typeof SiteProfileSchema>;

/** Without `id` a profile is created and `url` gives its site; with `id` it is replaced and its site stays. */
export const SaveSiteProfileSchema = z
  .object({
    id: z.uuid().optional(),
    url: z.string().max(2000).optional(),
    ...profileFields,
  })
  .refine((r) => r.id !== undefined || r.url !== undefined, { message: 'A new profile needs a URL', path: ['url'] });
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
export type SiteCrawlProblemReason = z.infer<typeof SiteCrawlProblemReasonSchema>;

export const SiteCrawlProblemSchema = z.object({
  url: z.string().max(10_000),
  stage: SiteCrawlStageSchema,
  reason: SiteCrawlProblemReasonSchema,
  detail: z.string().max(253).nullable(),
});
export type SiteCrawlProblem = z.infer<typeof SiteCrawlProblemSchema>;

/**
 * What a crawl found; nothing is downloaded until `sites:import` names `crawlId`. `problems` names, in the order
 * they arose, why pages or URLs gave nothing (each distinct problem once); `problemsDropped` counts those that did
 * not fit.
 */
export const SiteCrawlResultSchema = z.object({
  crawlId: z.uuid(),
  files: z.array(z.string()).max(SITE_MAX_FILES.max),
  pages: count,
  duplicates: count,
  filtered: count,
  disallowed: count,
  invalid: count,
  pageFailures: count,
  truncated: z.enum(['pages', 'files']).nullable(),
  cancelled: z.boolean(),
  problems: z.array(SiteCrawlProblemSchema).max(SITE_MAX_PROBLEMS),
  problemsDropped: count,
});
export type SiteCrawlResult = z.infer<typeof SiteCrawlResultSchema>;

export const SiteCrawlProgressSchema = z.object({ pages: count, files: count, cancelling: z.boolean() });
export type SiteCrawlProgress = z.infer<typeof SiteCrawlProgressSchema>;

/** The lower-case host of an http(s) URL without user info; null for anything else or a host ending in a dot. */
function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === '' || host.endsWith('.')) return null;
  return host;
}

/**
 * The site of a URL: its lower-case host without a leading `www.`. Null for a non-http(s) URL, user info, an empty
 * host or a host ending in a dot, and for a single label without a dot (`localhost`, `intranet`) unless it is an
 * IPv6 literal, since such a site would let every host under it belong to it. An IPv4 literal always has dots. It
 * does not apply the full URL rule of the import; the caller does.
 */
export function siteOf(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return null;
  const site = host.startsWith('www.') ? host.slice(4) : host;
  if (site === '') return null;
  if (!site.includes('.') && !site.startsWith('[')) return null;
  return site;
}

/** True when the URL is http(s) without user info and its host is `site` or ends with `.` + `site`. */
export function belongsToSite(url: string, site: string): boolean {
  const wanted = site.toLowerCase();
  if (wanted === '') return false;
  const host = hostOf(url);
  if (host === null) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}
