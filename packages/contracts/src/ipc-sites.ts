import { z } from 'zod';
import { FileTargetSchema } from './files';
import { UrlImportResultSchema } from './url-import';
import {
  MAX_SITE_PROFILES,
  SaveSiteProfileSchema,
  SiteCrawlProgressSchema,
  SiteCrawlResultSchema,
  SiteProfileSchema,
  SiteCrawlTaskSchema,
  SiteCrawlTaskSummarySchema,
  SITE_MAX_FILES,
} from './site-import';
import { type ChannelContracts, EmptyRequestSchema, IdRequestSchema, IdSchema } from './ipc-shared';

/** The site import channels: site profiles, the login window, the crawl and the import of its answer. */
export const siteChannels = {
  /**
   * App-level site profiles; the site channels need no open workspace except `sites:import`. No channel carries a
   * cookie.
   */
  'sites:list': {
    request: EmptyRequestSchema,
    response: z.object({ profiles: z.array(SiteProfileSchema).max(MAX_SITE_PROFILES) }),
  },
  /** Without `id` the profile is created with the site of `url`; with `id` it is replaced and keeps its site. */
  'sites:save': {
    request: SaveSiteProfileSchema,
    response: SiteProfileSchema,
  },
  /** Refused while the profile has active downloads, its login window is open or a crawl of it runs. */
  'sites:delete': {
    request: IdRequestSchema,
    response: z.object({}),
  },
  /** Opens the login window of the profile on `url`, or on `https://<site>/` without one. */
  'sites:openLogin': {
    request: z.object({ profileId: IdSchema, url: z.string().max(2000).optional() }),
    response: z.object({}),
  },
  /**
   * Opens the login window of the profile whose site is `host` (a paused download lane) so the owner can pass the
   * site's browser check by hand: on the newest download of that lane a browser check refused, else on
   * `https://<site>/`. The renderer names only the lane, never a URL. Nothing is solved automatically.
   */
  'sites:openCheck': {
    request: z.object({ host: z.string().min(1).max(300) }).strict(),
    response: z.object({}),
  },
  /** Reads the gallery at `url`, which must belong to the profile's site; one crawl at a time. Downloads nothing. */
  'sites:crawl': {
    request: z.object({ profileId: IdSchema, url: z.string().max(2000) }),
    response: SiteCrawlResultSchema,
  },
  /** Captures a workspace target and queues discovery without waiting for the browser. */
  'sites:enqueueCrawl': {
    request: z.object({ profileId: IdSchema, url: z.string().max(2000), target: FileTargetSchema.nullable() }),
    response: z.object({ crawlId: IdSchema }),
  },
  /** Saved discovery tasks of the open workspace, newest first. */
  'sites:listCrawls': {
    request: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    response: z.object({ items: z.array(SiteCrawlTaskSummarySchema), total: z.number().int().min(0) }),
  },
  /** Reads one saved task and recomputes optional filename matches against its captured asset. */
  'sites:getCrawl': {
    request: z.object({ crawlId: IdSchema }),
    response: SiteCrawlTaskSchema,
  },
  /** Retries saved discovery from its last checkpoint after a login or a transient failure. */
  'sites:retryCrawl': {
    request: z.object({ crawlId: IdSchema }),
    response: z.object({ retried: z.boolean() }),
  },
  /** Restarts a finished extraction from scratch in place using its live profile and captured destination. */
  'sites:restartCrawl': {
    request: z.object({ crawlId: IdSchema }),
    response: z.object({ restarted: z.boolean() }),
  },
  /** Removes finished extraction review metadata, preserving its downloads, files, profile and session. */
  'sites:removeCrawl': {
    request: z.object({ crawlId: IdSchema }),
    response: z.object({ removed: z.boolean() }),
  },
  /** Clears successfully completed imports only; preserves downloads, files and profiles. */
  'sites:clearCompletedCrawls': {
    request: EmptyRequestSchema,
    response: z.object({ removed: z.number().int().min(0) }),
  },
  /** The progress of the running crawl; null when none runs. */
  'sites:crawlProgress': {
    request: EmptyRequestSchema,
    response: SiteCrawlProgressSchema.nullable(),
  },
  /** Marks the running crawl to stop; `cancelling` is false when none runs. */
  'sites:cancelCrawl': {
    request: z.object({ crawlId: IdSchema.optional() }),
    response: z.object({ cancelling: z.boolean() }),
  },
  /** Queues the file URLs the crawl `crawlId` found; an unknown or replaced crawl is `invalid_operation`. */
  'sites:import': {
    request: z.object({
      crawlId: IdSchema,
      target: FileTargetSchema.nullable().optional(),
      selectedUrls: z.array(z.string().max(10_000)).max(SITE_MAX_FILES.max).optional(),
      skipExistingNames: z.boolean().optional(),
      includeExistingUrls: z.array(z.string().max(10_000)).max(SITE_MAX_FILES.max).optional(),
    }),
    response: UrlImportResultSchema,
  },
} as const satisfies ChannelContracts;
