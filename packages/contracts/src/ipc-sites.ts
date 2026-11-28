import { z } from 'zod';
import { FileTargetSchema } from './files';
import { UrlImportResultSchema } from './url-import';
import {
  MAX_SITE_PROFILES,
  SaveSiteProfileSchema,
  SiteCrawlProgressSchema,
  SiteCrawlResultSchema,
  SiteProfileSchema,
} from './site-import';
import { type ChannelContracts, EmptyRequestSchema, IdRequestSchema, IdSchema } from './ipc-shared';

/** The site import channels: site profiles, the login window, the crawl and the import of its answer. */
export const siteChannels = {
  /** App-level site profiles; the site channels need no open workspace except `sites:import`. No channel carries a cookie. */
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
  /** The progress of the running crawl; null when none runs. */
  'sites:crawlProgress': {
    request: EmptyRequestSchema,
    response: SiteCrawlProgressSchema.nullable(),
  },
  /** Marks the running crawl to stop; `cancelling` is false when none runs. */
  'sites:cancelCrawl': {
    request: EmptyRequestSchema,
    response: z.object({ cancelling: z.boolean() }),
  },
  /** Queues the file URLs the crawl `crawlId` found; an unknown or replaced crawl is `invalid_operation`. */
  'sites:import': {
    request: z.object({ crawlId: IdSchema, target: FileTargetSchema.nullable() }),
    response: UrlImportResultSchema,
  },
} as const satisfies ChannelContracts;
