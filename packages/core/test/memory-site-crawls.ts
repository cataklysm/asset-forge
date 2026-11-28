import {
  ACTIVE_JOB_STATUSES,
  SITE_CRAWL_JOB,
  SiteProfileSchema,
  type JobStatus,
  type SiteCrawlDownloads,
} from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError } from '../src/errors.js';
import type { NewJob } from '../src/job-types.js';
import type { SiteCrawlRecord, SiteCrawlRepository } from '../src/ports/site-crawl-repository.js';
import type { InMemoryJobRepository } from './memory-jobs.js';

/** JSON copy, matching persistence of captured requests and recovery metadata. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Durable discovery records over a map; associated jobs live in the existing in-memory queue. */
export class InMemorySiteCrawlRepository implements SiteCrawlRepository {
  readonly rows = new Map<string, SiteCrawlRecord>();
  private readonly downloads = new Map<string, Map<string, { jobId: string | null; status: JobStatus }>>();

  constructor(private readonly jobs: InMemoryJobRepository) {}

  async insert(record: SiteCrawlRecord, queuedJob?: NewJob): Promise<void> {
    if (this.rows.has(record.id)) throw new Error('UNIQUE constraint failed: site_crawl.id');
    if (queuedJob !== undefined && (queuedJob.id !== record.id || queuedJob.type !== SITE_CRAWL_JOB)) {
      throw new ValidationFailedError('The discovery job does not match the crawl');
    }
    const captured = copy({ ...record, profile: SiteProfileSchema.parse(record.profile) });
    if (queuedJob !== undefined) {
      const inserted = await this.jobs.enqueue({ jobs: [queuedJob], now: record.createdAt });
      if (!inserted.includes(queuedJob.id)) throw new InvalidOperationError('The discovery job could not be queued');
    }
    this.rows.set(record.id, captured);
  }

  async get(id: string): Promise<SiteCrawlRecord | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : copy(row);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.rows.has(id)) return false;
    const active = this.jobs.rows.some(
      (job) =>
        job.id === id && job.type === SITE_CRAWL_JOB && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status),
    );
    if (active) throw new InvalidOperationError('Cancel this extraction before removing it');
    this.downloads.delete(id);
    return this.rows.delete(id);
  }

  async list(page: { limit: number; offset: number }): Promise<{ items: SiteCrawlRecord[]; total: number }> {
    const rows = [...this.rows.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    return { items: copy(rows.slice(page.offset, page.offset + page.limit)), total: rows.length };
  }

  async restart(id: string, profile: Parameters<SiteCrawlRepository['restart']>[1], now: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (existing === undefined) return false;
    const parsed = SiteProfileSchema.parse(profile);
    if (parsed.id !== existing.profile.id || parsed.site !== existing.profile.site)
      throw new ValidationFailedError('The extraction profile identity cannot change');
    const index = this.jobs.rows.findIndex((job) => job.id === id);
    const previous = this.jobs.rows[index];
    if (
      previous !== undefined &&
      (previous.type !== SITE_CRAWL_JOB || (ACTIVE_JOB_STATUSES as readonly string[]).includes(previous.status))
    )
      throw new InvalidOperationError('Cancel this extraction before restarting it');
    this.downloads.delete(id);
    if (previous !== undefined) this.jobs.rows.splice(index, 1);
    await this.jobs.enqueue({
      jobs: [
        {
          id,
          type: SITE_CRAWL_JOB,
          resourceClass: 'cpu',
          fileId: null,
          lane: parsed.site,
          payload: { v: 1, crawlId: id },
          dedupeKey: null,
        },
      ],
      now,
    });
    this.rows.set(
      id,
      copy({
        ...existing,
        profile: parsed,
        progress: { pages: 0, files: 0, cancelling: false },
        result: null,
        checkpoint: null,
        importedAt: null,
        completedAt: null,
        updatedAt: now,
      }),
    );
    return true;
  }

  async enqueueDownloads(
    id: string,
    jobs: readonly NewJob[],
    knownUrls: readonly string[],
    now: string,
  ): Promise<string[]> {
    const record = this.rows.get(id);
    if (record === undefined) throw new InvalidOperationError('This extraction no longer exists');
    const inserted = await this.jobs.enqueue({ jobs, now });
    const links = this.downloads.get(id) ?? new Map<string, { jobId: string | null; status: JobStatus }>();
    for (const input of jobs) {
      const holder = this.jobs.rows.find(
        (row) =>
          row.id === input.id ||
          (row.dedupeKey === input.dedupeKey && (ACTIVE_JOB_STATUSES as readonly string[]).includes(row.status)),
      );
      if (holder === undefined) throw new InvalidOperationError('The extraction download could not be tracked');
      links.set((input.payload as { url: string }).url, { jobId: holder.id, status: holder.status });
    }
    for (const url of knownUrls) links.set(url, { jobId: null, status: 'succeeded' });
    this.downloads.set(id, links);
    this.rows.set(id, { ...record, importedAt: now, updatedAt: now });
    return inserted;
  }

  async downloadProgress(id: string): Promise<SiteCrawlDownloads | null> {
    const links = this.downloads.get(id);
    if (links === undefined || links.size === 0) return null;
    const answer = { total: links.size, queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const link of links.values()) {
      link.status = this.jobs.rows.find((row) => row.id === link.jobId)?.status ?? link.status;
      const key = link.status === 'retry_wait' || link.status === 'waiting_remote' ? 'waiting' : link.status;
      answer[key]++;
    }
    return answer;
  }

  async clearCompleted(): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.rows) {
      const progress = await this.downloadProgress(id);
      if (
        record.importedAt !== null &&
        progress !== null &&
        progress.total === progress.succeeded &&
        (await this.remove(id))
      )
        removed++;
    }
    return removed;
  }

  async listSummaries(page: { limit: number; offset: number }): ReturnType<SiteCrawlRepository['listSummaries']> {
    const rows = [...this.rows.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    const items = rows
      .slice(page.offset, page.offset + page.limit)
      .map(({ result, checkpoint: _checkpoint, ...header }) =>
        copy({ ...header, cancelled: result?.cancelled ?? false }),
      );
    return { items, total: rows.length };
  }

  async update(id: string, patch: Parameters<SiteCrawlRepository['update']>[1]): Promise<boolean> {
    const current = this.rows.get(id);
    if (current === undefined) return false;
    const updated = { ...current, updatedAt: patch.now };
    if (patch.progress !== undefined) updated.progress = patch.progress;
    if (patch.result !== undefined) updated.result = patch.result;
    if (patch.checkpoint !== undefined) updated.checkpoint = patch.checkpoint;
    if (patch.importedAt !== undefined) updated.importedAt = patch.importedAt;
    if (patch.completedAt !== undefined) updated.completedAt = patch.completedAt;
    this.rows.set(id, copy(updated));
    return true;
  }

  async hasActiveProfile(profileId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (record) =>
        record.profile.id === profileId &&
        this.jobs.rows.some(
          (job) => job.id === record.id && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status),
        ),
    );
  }
}
