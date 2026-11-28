import {
  ACTIVE_JOB_STATUSES,
  FILE_DOWNLOAD_JOB,
  FileDownloadPayloadSchema,
  type SiteCrawlDownloads,
} from '@assetforge/contracts';
import { InvalidOperationError, ValidationFailedError, type SiteCrawlRepository } from '@assetforge/core';
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { insertJob } from './job-repository.js';
import { job, siteCrawl, siteCrawlDownload } from './schema.js';

/**
 * Queues and associates each requested URL atomically, including a URL whose job another extraction already queued.
 * @param database workspace connection
 * @param id extraction receiving these downloads
 * @param jobs prepared download jobs
 * @param knownUrls already imported source URLs
 * @param now import time
 * @returns newly inserted job IDs
 */
export async function enqueueCrawlDownloads(
  database: BetterSQLite3Database,
  id: string,
  jobs: Parameters<SiteCrawlRepository['enqueueDownloads']>[1],
  knownUrls: readonly string[],
  now: string,
): Promise<string[]> {
  return database.transaction((transaction) => {
    if (transaction.select({ id: siteCrawl.id }).from(siteCrawl).where(eq(siteCrawl.id, id)).get() === undefined) {
      throw new InvalidOperationError('This extraction no longer exists');
    }
    const inserted: string[] = [];
    for (const input of jobs) {
      const payload = FileDownloadPayloadSchema.safeParse(input.payload);
      if (input.type !== FILE_DOWNLOAD_JOB || input.fileId !== null || !payload.success)
        throw new ValidationFailedError('The extraction download is invalid');
      const added = insertJob(transaction, input, now);
      if (added) inserted.push(input.id);
      const holder = transaction
        .select({ id: job.id, status: job.status })
        .from(job)
        .where(
          added
            ? eq(job.id, input.id)
            : and(
                eq(job.type, FILE_DOWNLOAD_JOB),
                eq(job.dedupeKey, input.dedupeKey ?? ''),
                inArray(job.status, [...ACTIVE_JOB_STATUSES]),
              ),
        )
        .get();
      if (holder === undefined) throw new InvalidOperationError('The extraction download could not be tracked');
      transaction
        .insert(siteCrawlDownload)
        .values({ crawlId: id, url: payload.data.url, jobId: holder.id, status: holder.status })
        .onConflictDoUpdate({
          target: [siteCrawlDownload.crawlId, siteCrawlDownload.url],
          set: { jobId: holder.id, status: holder.status },
        })
        .run();
    }
    for (const url of knownUrls) {
      transaction
        .insert(siteCrawlDownload)
        .values({ crawlId: id, url, jobId: null, status: 'succeeded' })
        .onConflictDoUpdate({
          target: [siteCrawlDownload.crawlId, siteCrawlDownload.url],
          set: { jobId: null, status: 'succeeded' },
        })
        .run();
    }
    transaction.update(siteCrawl).set({ importedAt: now, updatedAt: now }).where(eq(siteCrawl.id, id)).run();
    return inserted;
  });
}

/**
 * Counts one extraction's download outcomes, including outcomes retained after job-history cleanup.
 * @param database workspace connection
 * @param id saved extraction
 * @returns counts or null when no import was tracked
 */
export async function crawlDownloadProgress(
  database: BetterSQLite3Database,
  id: string,
): Promise<SiteCrawlDownloads | null> {
  const rows = database
    .select({ status: siteCrawlDownload.status, total: count() })
    .from(siteCrawlDownload)
    .where(eq(siteCrawlDownload.crawlId, id))
    .groupBy(siteCrawlDownload.status)
    .all();
  if (rows.length === 0) return null;
  const answer: SiteCrawlDownloads = {
    total: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    answer.total += row.total;
    const key = row.status === 'retry_wait' || row.status === 'waiting_remote' ? 'waiting' : row.status;
    answer[key] += row.total;
  }
  return answer;
}

/**
 * Clears only imported reviews whose tracked URLs all succeeded, never failures, unreviewed results or active crawls.
 * @param database workspace connection
 * @returns removed review count
 */
export async function clearCompletedCrawls(database: BetterSQLite3Database): Promise<number> {
  return database
    .delete(siteCrawl)
    .where(
      and(
        isNotNull(siteCrawl.importedAt),
        sql`EXISTS (SELECT 1 FROM ${siteCrawlDownload} WHERE ${siteCrawlDownload.crawlId} = ${siteCrawl.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${siteCrawlDownload} WHERE ${siteCrawlDownload.crawlId} = ${siteCrawl.id} AND ${siteCrawlDownload.status} <> 'succeeded')`,
        sql`NOT EXISTS (SELECT 1 FROM ${job} WHERE ${job.id} = ${siteCrawl.id} AND ${inArray(job.status, [...ACTIVE_JOB_STATUSES])})`,
      ),
    )
    .run().changes;
}
