import { ACTIVE_JOB_STATUSES, SITE_CRAWL_JOB, SiteProfileSchema } from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError } from '../src/errors.js';
import type { NewJob } from '../src/job-types.js';
import type { SiteCrawlRecord, SiteCrawlRepository } from '../src/ports/site-crawl-repository.js';
import type { InMemoryJobRepository } from './memory-jobs.js';

/** JSON copy, matching persistence of captured requests and recovery metadata. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Durable discovery records over a map; associated jobs live in the existing in-memory queue. */
export class InMemorySiteCrawlRepository implements SiteCrawlRepository {
  readonly rows = new Map<string, SiteCrawlRecord>();

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

  async list(page: { limit: number; offset: number }): Promise<{ items: SiteCrawlRecord[]; total: number }> {
    const rows = [...this.rows.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    return { items: copy(rows.slice(page.offset, page.offset + page.limit)), total: rows.length };
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
