import type {
  FileTarget,
  SiteCrawlDownloads,
  SiteCrawlProgress,
  SiteCrawlResult,
  SiteProfile,
} from '@assetforge/contracts';
import type { NewJob } from '../job-types.js';

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
  /** Set only after discovery completes successfully, independent of technical job-history retention. */
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Queue-list projection that never reads or decodes large result/checkpoint JSON columns. */
export type SiteCrawlSummaryRecord = Omit<SiteCrawlRecord, 'result' | 'checkpoint'> & { cancelled: boolean };

/** Workspace-local discovery results and recovery checkpoints. */
export interface SiteCrawlRepository {
  /** @param record captured profile and destination, without credentials @param queuedJob optional job inserted atomically */
  insert(record: SiteCrawlRecord, queuedJob?: NewJob): Promise<void>;
  /** @param id the crawl and associated job id @returns saved state or null */
  get(id: string): Promise<SiteCrawlRecord | null>;
  /**
   * Removes only saved review/checkpoint metadata; jobs, downloads and files are preserved.
   * @param id the crawl
   * @returns whether saved metadata was removed
   * @throws InvalidOperationError while its associated discovery job is active
   */
  remove(id: string): Promise<boolean>;
  /**
   * Atomically clears review/recovery state and queues the same finished task with a live profile.
   * @param id the existing crawl and job id
   * @param profile the current profile with the same identity and site
   * @param now the restart time
   * @returns whether the crawl exists
   * @throws InvalidOperationError while its discovery job is active
   */
  restart(id: string, profile: SiteProfile, now: string): Promise<boolean>;
  /** @param id existing crawl @param jobs new download requests @param knownUrls already imported URLs @param now import time @returns inserted job IDs; tracks shared pending downloads too */
  enqueueDownloads(id: string, jobs: readonly NewJob[], knownUrls: readonly string[], now: string): Promise<string[]>;
  /** @param id extraction @returns durable counters or null before tracking/import */
  downloadProgress(id: string): Promise<SiteCrawlDownloads | null>;
  /** @returns number of successfully completed import reviews cleared; never clears failures or running work */
  clearCompleted(): Promise<number>;
  /** @param page pagination @returns newest saved tasks first */
  list(page: { limit: number; offset: number }): Promise<{ items: SiteCrawlRecord[]; total: number }>;
  /** @param page pagination @returns lightweight queue metadata without result/checkpoint arrays */
  listSummaries(page: { limit: number; offset: number }): Promise<{ items: SiteCrawlSummaryRecord[]; total: number }>;
  /** @param id crawl id @param update checkpoint or review changes @returns whether the crawl exists */
  update(
    id: string,
    update: {
      progress?: SiteCrawlProgress;
      result?: SiteCrawlResult | null;
      checkpoint?: unknown | null;
      importedAt?: string | null;
      completedAt?: string | null;
      now: string;
    },
  ): Promise<boolean>;
  /** @param profileId site profile @returns whether active jobs still depend on this profile */
  hasActiveProfile(profileId: string): Promise<boolean>;
}
