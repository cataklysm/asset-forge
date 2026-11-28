import type { FileTarget, SiteCrawlProgress, SiteCrawlResult, SiteProfile } from '@assetforge/contracts';

/** Saved discovery state, independent of the dialog and technical job retention. */
export interface SiteCrawlRecord {
  id: string;
  profile: SiteProfile;
  galleryUrl: string;
  target: FileTarget | null;
  targetAssetName: string | null;
  progress: SiteCrawlProgress;
  result: SiteCrawlResult | null;
  checkpoint: unknown | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Workspace-local discovery results and recovery checkpoints. */
export interface SiteCrawlRepository {
  /** @param record captured profile and destination, without credentials */
  insert(record: SiteCrawlRecord): Promise<void>;
  /** @param id the crawl and associated job id @returns saved state or null */
  get(id: string): Promise<SiteCrawlRecord | null>;
  /** @param page pagination @returns newest saved tasks first */
  list(page: { limit: number; offset: number }): Promise<{ items: SiteCrawlRecord[]; total: number }>;
  /** @param id crawl id @param update checkpoint or review changes @returns whether the crawl exists */
  update(id: string, update: {
    progress?: SiteCrawlProgress;
    result?: SiteCrawlResult | null;
    checkpoint?: unknown | null;
    importedAt?: string | null;
    now: string;
  }): Promise<boolean>;
  /** @param profileId site profile @returns whether active jobs still depend on this profile */
  hasActiveProfile(profileId: string): Promise<boolean>;
}
