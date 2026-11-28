import { FINISHED_JOB_STATUSES } from '@assetforge/contracts';
import type { GenerationRepository, GenerationRow, JobOutcome } from '@assetforge/core';
import { and, count, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileRefRow, loadGenerations, type GenerationReader } from './generation-rows.js';
import { insertJob } from './job-repository.js';
import { errorCodeOf } from './job-rows.js';
import { generation, generationInput, generationOutput, job } from './schema.js';

/** The generations that may be removed or requeued: failed or cancelled. */
const isRetired = inArray(generation.status, ['failed', 'cancelled']);

/**
 * Whether a job status is a finished one.
 *
 * @param status the status
 * @returns true for a finished status
 */
const isFinishedJob = (status: string): status is (typeof FINISHED_JOB_STATUSES)[number] =>
  (FINISHED_JOB_STATUSES as readonly string[]).includes(status);

/**
 * The generation repository on the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createGenerationRepository(database: BetterSQLite3Database): GenerationRepository {
  return {
    create: (input) => createGeneration(database, input),
    get: async (id) => firstGeneration(database, eq(generation.id, id)),
    byJob: async (jobId) => firstGeneration(database, eq(generation.jobId, jobId)),
    madeBy: (fileId) => madeBy(database, fileId),
    resultsOf: (fileId, limit) => resultsOf(database, fileId, limit),
    editRank: (id) => editRank(database, id),
    succeed: (input) => succeed(database, input),
    settle: (input) => settle(database, input),
    requeue: (input) => requeue(database, input),
    remove: (id) => removeGeneration(database, id),
    recentPrompts: (limit) => recentPrompts(database, limit),
    reconcile: (now) => reconcile(database, now),
  };
}

/**
 * Runs `work` in a read transaction.
 *
 * @param database the workspace database
 * @param work the reads
 * @returns what `work` answers
 */
function read<T>(database: BetterSQLite3Database, work: (transaction: GenerationReader) => T): T {
  return database.transaction(work, { behavior: 'deferred' });
}

/**
 * The first generation matching the condition.
 *
 * @param database the workspace database
 * @param where the condition
 * @returns the generation; null when none matches
 */
function firstGeneration(database: BetterSQLite3Database, where: SQL): GenerationRow | null {
  return read(database, (transaction) => loadGenerations(transaction, where, [], 1)[0] ?? null);
}

/**
 * Inserts a pending generation, its input and its job in one transaction.
 *
 * @param database the workspace database
 * @param input the generation, its input file and its job
 * @returns nothing; rejects when the job was not inserted, and then nothing is written
 */
async function createGeneration(
  database: BetterSQLite3Database,
  { generation: record, input, job: newJob }: Parameters<GenerationRepository['create']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .insert(generation)
      .values({
        id: record.id,
        kind: record.kind,
        status: 'pending',
        errorCode: null,
        providerId: record.providerId,
        providerName: record.providerName,
        providerKind: record.providerKind,
        model: record.model,
        prompt: record.prompt,
        parameters: JSON.stringify(record.parameters),
        jobId: newJob.id,
        createdAt: record.createdAt,
        finishedAt: null,
        promptVersionId: record.promptRef?.versionId ?? null,
        promptTitle: record.promptRef?.title ?? null,
        promptVersionNumber: record.promptRef?.versionNumber ?? null,
        promptVariables: record.promptRef ? JSON.stringify({ v: 1, values: record.promptRef.variables }) : null,
      })
      .run();
    transaction
      .insert(generationInput)
      .values(fileRefRow(record.id, 0, input))
      .run();
    // A skipped job (file gone or trashed) rolls the whole transaction back.
    if (!insertJob(transaction, newJob, record.createdAt)) throw new Error('The generation job was not inserted');
  });
}

/**
 * The generation that wrote the file.
 *
 * @param database the workspace database
 * @param fileId the output file
 * @returns the generation; null when no generation wrote it
 */
async function madeBy(database: BetterSQLite3Database, fileId: string): Promise<GenerationRow | null> {
  const wroteTheFile = sql`exists (select 1 from ${generationOutput} where ${generationOutput.generationId} = ${generation.id} and ${generationOutput.fileId} = ${fileId})`;
  return firstGeneration(database, wroteTheFile);
}

/**
 * The generations that read the file, newest first.
 *
 * @param database the workspace database
 * @param fileId the input file
 * @param limit the most generations to answer
 * @returns the generations
 */
async function resultsOf(database: BetterSQLite3Database, fileId: string, limit: number): Promise<GenerationRow[]> {
  const readTheFile = sql`exists (select 1 from ${generationInput} where ${generationInput.generationId} = ${generation.id} and ${generationInput.fileId} = ${fileId})`;
  return read(database, (transaction) =>
    loadGenerations(transaction, readTheFile, [desc(generation.createdAt), desc(generation.id)], limit),
  );
}

/**
 * The number of an edit among the edits of the same input file, counted from 1 in creation order.
 *
 * @param database the workspace database
 * @param id the generation
 * @returns the number; 0 for an upscale, an unknown generation or one whose input was purged
 */
async function editRank(database: BetterSQLite3Database, id: string): Promise<number> {
  return read(database, (transaction) => {
    const row = transaction
      .select({ kind: generation.kind, createdAt: generation.createdAt, fileId: generationInput.fileId })
      .from(generation)
      .innerJoin(generationInput, and(eq(generationInput.generationId, generation.id), eq(generationInput.position, 0)))
      .where(eq(generation.id, id))
      .get();
    // A purged input file no longer tells which edits belong together.
    if (!row || row.kind !== 'edit' || row.fileId === null) return 0;
    const before = transaction
      .select({ n: count() })
      .from(generation)
      .innerJoin(generationInput, eq(generationInput.generationId, generation.id))
      .where(
        and(
          eq(generation.kind, 'edit'),
          eq(generationInput.fileId, row.fileId),
          or(
            lt(generation.createdAt, row.createdAt),
            and(eq(generation.createdAt, row.createdAt), lt(generation.id, id)),
          ),
        ),
      )
      .get();
    return (before?.n ?? 0) + 1;
  });
}

/**
 * Marks a pending generation as succeeded and links its output as the next one, in one transaction.
 *
 * @param database the workspace database
 * @param input the generation, the output file and the time
 * @returns true when the generation was pending
 */
async function succeed(
  database: BetterSQLite3Database,
  { id, output, now }: Parameters<GenerationRepository['succeed']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const changed =
      transaction
        .update(generation)
        .set({ status: 'succeeded', errorCode: null, finishedAt: now })
        .where(and(eq(generation.id, id), eq(generation.status, 'pending')))
        .run().changes > 0;
    if (!changed) return false;
    const next = transaction
      .select({ n: count() })
      .from(generationOutput)
      .where(eq(generationOutput.generationId, id))
      .get();
    transaction
      .insert(generationOutput)
      .values(fileRefRow(id, next?.n ?? 0, output))
      .run();
    return true;
  });
}

/**
 * The final state of a pending generation for its job's outcome.
 *
 * @param outcome the job's outcome
 * @returns the status and the error code to store
 */
function endOf(outcome: JobOutcome) {
  if (outcome.status === 'cancelled') return { status: 'cancelled' as const, errorCode: null };
  if (outcome.status === 'failed') return { status: 'failed' as const, errorCode: outcome.errorCode };
  // A succeeded job whose generation is still pending never linked its result.
  return { status: 'failed' as const, errorCode: 'internal_error' as const };
}

/**
 * Ends a pending generation for its job's outcome. Synchronous, so it can run inside a job repository transaction on
 * the same connection.
 *
 * @param database the workspace database
 * @param input the generation, the job's outcome and the time
 * @returns true when the generation was pending
 */
function settle(
  database: BetterSQLite3Database,
  { id, outcome, now }: { id: string; outcome: JobOutcome; now: string },
): boolean {
  return (
    database
      .update(generation)
      .set({ ...endOf(outcome), finishedAt: now })
      .where(and(eq(generation.id, id), eq(generation.status, 'pending')))
      .run().changes > 0
  );
}

/**
 * Makes a failed or cancelled generation pending again with a new job, in one transaction.
 *
 * @param database the workspace database
 * @param input the generation, the new job and the time
 * @returns true when the generation was retired and the job was inserted
 */
async function requeue(
  database: BetterSQLite3Database,
  { id, job: newJob, now }: Parameters<GenerationRepository['requeue']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const row = transaction
      .select({ id: generation.id })
      .from(generation)
      .where(and(eq(generation.id, id), isRetired))
      .get();
    if (!row) return false;
    if (!insertJob(transaction, newJob, now)) return false;
    transaction
      .update(generation)
      .set({ status: 'pending', errorCode: null, finishedAt: null, jobId: newJob.id })
      .where(eq(generation.id, id))
      .run();
    return true;
  });
}

/**
 * Deletes a failed or cancelled generation.
 *
 * @param database the workspace database
 * @param id the generation
 * @returns true when it was deleted
 */
async function removeGeneration(database: BetterSQLite3Database, id: string): Promise<boolean> {
  // The input and output rows go with it through their `cascade` rule.
  return (
    database
      .delete(generation)
      .where(and(eq(generation.id, id), isRetired))
      .run().changes > 0
  );
}

/**
 * The distinct prompts of the edits, the one used last first.
 *
 * @param database the workspace database
 * @param limit the most prompts to answer
 * @returns the prompts
 */
async function recentPrompts(database: BetterSQLite3Database, limit: number): Promise<string[]> {
  // The newest use of each distinct prompt, then the newest of those first.
  const uses = database
    .select({
      prompt: generation.prompt,
      createdAt: generation.createdAt,
      id: generation.id,
      rank: sql<number>`row_number() over (partition by ${generation.prompt} order by ${generation.createdAt} desc, ${generation.id} desc)`.as(
        'rank',
      ),
    })
    .from(generation)
    .where(and(eq(generation.kind, 'edit'), isNotNull(generation.prompt)))
    .as('uses');
  return database
    .select({ prompt: uses.prompt })
    .from(uses)
    .where(eq(uses.rank, 1))
    .orderBy(desc(uses.createdAt), desc(uses.id))
    .limit(limit)
    .all()
    .flatMap((row) => (row.prompt === null ? [] : [row.prompt]));
}

/**
 * The outcome a pending generation's job stands for.
 *
 * @param jobStatus the job's status; null when the job is gone
 * @param jobErrorCode the job's stored error code
 * @returns the outcome; null while the job has not finished
 */
function outcomeOfJob(jobStatus: string | null, jobErrorCode: string | null): JobOutcome | null {
  if (jobStatus === null) return { status: 'failed', errorCode: 'provider_outcome_unknown' };
  if (!isFinishedJob(jobStatus)) return null;
  if (jobStatus === 'failed') return { status: 'failed', errorCode: errorCodeOf(jobErrorCode) ?? 'internal_error' };
  if (jobStatus === 'cancelled') return { status: 'cancelled' };
  return { status: 'succeeded' };
}

/**
 * Ends every pending generation whose job is gone or finished, in one transaction.
 *
 * @param database the workspace database
 * @param now the time
 * @returns the number of generations ended
 */
async function reconcile(database: BetterSQLite3Database, now: string): Promise<number> {
  return database.transaction((transaction) => {
    const pending = transaction
      .select({ id: generation.id, jobStatus: job.status, jobErrorCode: job.errorCode })
      .from(generation)
      .leftJoin(job, eq(job.id, generation.jobId))
      .where(eq(generation.status, 'pending'))
      .all();
    let changed = 0;
    for (const entry of pending) {
      const outcome = outcomeOfJob(entry.jobStatus, entry.jobErrorCode);
      if (outcome === null) continue;
      if (settle(database, { id: entry.id, outcome, now })) changed++;
    }
    return changed;
  });
}
