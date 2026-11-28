import {
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  analysisJobFields,
  downloadJobFields,
  type JobView,
} from '@assetforge/contracts';
import type { JobRepository } from '@assetforge/core';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { errorCodeOf, inLane, resultOf, type JobReader, type JobRow } from './job-rows.js';
import { file, generation, job } from './schema.js';

// The job list of the Jobs screen: one page of jobs with what each row shows besides the job itself.

/** What the job list asks for: the page and the filters. */
type JobListFilter = Parameters<JobRepository['list']>[0];

/** One job of the page with the columns joined to it. */
interface JobListEntry {
  /** The job row. */
  job: JobRow;
  /** The name of its file; null without one. */
  fileName: string | null;
  /** The provider name of the generation it runs; null for other jobs. */
  generationProviderName: string | null;
  /** The model of the generation it runs; null for other jobs. */
  generationModel: string | null;
}

/**
 * One page of jobs, newest first, and the number of jobs matching the filters; both read in one transaction.
 *
 * @param database the workspace database
 * @param filter the page and the filters
 * @returns the page and the total; rejects when a payload is not JSON
 */
export async function listJobs(
  database: BetterSQLite3Database,
  filter: JobListFilter,
): Promise<{ items: JobView[]; total: number }> {
  const where = jobListWhere(filter);
  return database.transaction(
    (transaction) => {
      const rows = selectJobPage(transaction, where, filter);
      const total = transaction.select({ n: count() }).from(job).where(where).get()?.n ?? 0;
      const items = rows.map(toJobView);
      return { items, total };
    },
    { behavior: 'deferred' },
  );
}

/**
 * The condition of the filters; each one given narrows the list.
 *
 * @param filter the filters
 * @returns the condition; undefined without filters
 */
function jobListWhere({ status, lane, ids }: JobListFilter): SQL | undefined {
  return and(
    status === undefined ? undefined : eq(job.status, status),
    // `inLane`, so a null lane matches the jobs without one instead of no row (`= NULL` is never true).
    lane === undefined ? undefined : inLane(lane),
    ids === undefined ? undefined : inArray(job.id, [...ids]),
  );
}

/**
 * The jobs of one page with their file name and the generation they run.
 *
 * @param reader the caller's transaction
 * @param where the condition of the filters
 * @param page the limit and the offset
 * @returns the entries, newest first
 */
function selectJobPage(reader: JobReader, where: SQL | undefined, page: JobListFilter): JobListEntry[] {
  return (
    reader
      .select({
        job,
        fileName: file.originalName,
        generationProviderName: generation.providerName,
        generationModel: generation.model,
      })
      .from(job)
      .leftJoin(file, eq(file.id, job.fileId))
      // The generation named in the payload, so an earlier run of a requeued generation is named too.
      .leftJoin(
        generation,
        and(eq(job.type, IMAGE_GENERATE_JOB), sql`${generation.id} = json_extract(${job.payload}, '$.generationId')`),
      )
      .where(where)
      .orderBy(desc(job.createdAt), desc(job.id))
      .limit(page.limit)
      .offset(page.offset)
      .all()
  );
}

/**
 * One entry as the row of the Jobs screen.
 *
 * @param entry the job with its joined columns
 * @returns the view; throws when the payload is not JSON
 */
function toJobView(entry: JobListEntry): JobView {
  const row = entry.job;
  const payload = JSON.parse(row.payload) as unknown;
  const isDownload = row.type === FILE_DOWNLOAD_JOB;
  return {
    ...providerFieldsOf(entry, payload),
    id: row.id,
    type: row.type,
    status: row.status,
    attempt: row.attempt,
    fileId: row.fileId,
    fileName: entry.fileName,
    errorCode: errorCodeOf(row.errorCode),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    runAfter: row.runAfter,
    // A download's lane is its host, not a provider.
    providerId: isDownload ? null : row.providerId,
    ...(isDownload ? downloadJobFields(payload) : { url: null, host: null }),
    result: resultOf(row.result),
  };
}

/**
 * The provider name and model a row shows: a generation's from its record, none for a download, an analysis job's
 * from its payload.
 *
 * @param entry the job with its joined columns
 * @param payload the parsed payload
 * @returns the provider name and the model
 */
function providerFieldsOf(entry: JobListEntry, payload: unknown) {
  if (entry.job.type === IMAGE_GENERATE_JOB) {
    return { providerName: entry.generationProviderName, model: entry.generationModel };
  }
  if (entry.job.type === FILE_DOWNLOAD_JOB) return { providerName: null, model: null };
  return analysisJobFields(payload);
}
