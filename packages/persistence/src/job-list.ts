import { IMAGE_GENERATE_JOB, type JobView } from '@assetforge/contracts';
import { jobViewOf, type JobRepository } from '@assetforge/core';
import { and, count, desc, eq, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { inLane, resultOf, toJob, type JobReader, type JobRow } from './job-rows.js';
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
function jobListWhere({ status, lane, laneOutside, ids }: JobListFilter): SQL | undefined {
  return and(
    status === undefined ? undefined : eq(job.status, status),
    // `inLane`, so a null lane matches the jobs without one instead of no row (`= NULL` is never true).
    lane === undefined ? undefined : inLane(lane),
    laneOutside === undefined ? undefined : outsideLanes(laneOutside),
    ids === undefined ? undefined : inArray(job.id, [...ids]),
  );
}

/**
 * The jobs of these resource classes that have a lane and whose lane is not one of `lanes`.
 *
 * @param filter the resource classes and the lanes to leave out
 * @returns the condition
 */
function outsideLanes({ resourceClasses, lanes }: NonNullable<JobListFilter['laneOutside']>): SQL | undefined {
  return and(
    inArray(job.resourceClass, [...resourceClasses]),
    isNotNull(job.providerId),
    lanes.length === 0 ? undefined : notInArray(job.providerId, [...lanes]),
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
  return jobViewOf(toJob(entry.job), {
    fileName: entry.fileName,
    generation: { providerName: entry.generationProviderName, model: entry.generationModel },
    result: resultOf(entry.job.result),
  });
}
