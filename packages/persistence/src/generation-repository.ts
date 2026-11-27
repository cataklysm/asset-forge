import { FINISHED_JOB_STATUSES, GenerationParametersSchema, GenerationSchema, type GenerationFile } from '@assetforge/contracts';
import type { GenerationFileRef, GenerationRepository, GenerationRow, JobOutcome } from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { errorCodeOf, insertJob } from './job-repository.js';
import { file, generation, generationInput, generationOutput, job, promptVersion } from './schema.js';

type Tx = Pick<BetterSQLite3Database, 'select'>;
type FileTable = typeof generationInput | typeof generationOutput;

const ValuesSchema = GenerationSchema.shape.promptVariables.unwrap();

/** The `prompt_variables` column; null when absent or when it does not parse. */
function parseValues(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  try {
    const column: unknown = JSON.parse(text);
    if (typeof column !== 'object' || column === null || (column as { v?: unknown }).v !== 1) return null;
    const parsed = ValuesSchema.safeParse((column as { values?: unknown }).values);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const isFinishedJob = (status: string): status is (typeof FINISHED_JOB_STATUSES)[number] =>
  (FINISHED_JOB_STATUSES as readonly string[]).includes(status);

/** The input or output rows of these generations, by generation id in position order, with the file's trash state. */
function filesOf(tx: Tx, table: FileTable, ids: readonly string[]): Map<string, GenerationFile[]> {
  const result = new Map<string, GenerationFile[]>();
  if (ids.length === 0) return result;
  const rows = tx
    .select({
      generationId: table.generationId,
      fileId: table.fileId,
      name: table.originalName,
      sha256: table.sha256,
      deletedAt: file.deletedAt,
    })
    .from(table)
    .leftJoin(file, eq(file.id, table.fileId))
    .where(inArray(table.generationId, [...ids]))
    .orderBy(asc(table.generationId), asc(table.position))
    .all();
  for (const r of rows) {
    const list = result.get(r.generationId) ?? [];
    list.push({ fileId: r.fileId, name: r.name, sha256: r.sha256, trashed: r.deletedAt !== null });
    result.set(r.generationId, list);
  }
  return result;
}

/** The generations matching `where` in `orderBy` order, with their job status and files. Throws on unparsable parameters. */
function load(tx: Tx, where: SQL | undefined, order: SQL[] = [], limit?: number): GenerationRow[] {
  const query = tx
    .select({ g: generation, jobStatus: job.status, promptId: promptVersion.promptId })
    .from(generation)
    .leftJoin(job, eq(job.id, generation.jobId))
    .leftJoin(promptVersion, eq(promptVersion.id, generation.promptVersionId))
    .where(where)
    .orderBy(...order);
  const rows = limit === undefined ? query.all() : query.limit(limit).all();
  const ids = rows.map((r) => r.g.id);
  const inputs = filesOf(tx, generationInput, ids);
  const outputs = filesOf(tx, generationOutput, ids);
  return rows.map(({ g, jobStatus, promptId }) => ({
    id: g.id,
    kind: g.kind,
    status: g.status,
    errorCode: errorCodeOf(g.errorCode),
    providerId: g.providerId,
    providerName: g.providerName,
    providerKind: g.providerKind,
    model: g.model,
    prompt: g.prompt,
    parameters: GenerationParametersSchema.parse(JSON.parse(g.parameters)),
    jobId: g.jobId,
    jobStatus,
    createdAt: g.createdAt,
    finishedAt: g.finishedAt,
    inputs: inputs.get(g.id) ?? [],
    outputs: outputs.get(g.id) ?? [],
    promptId: g.promptVersionId === null ? null : promptId,
    promptVersionId: g.promptVersionId,
    promptTitle: g.promptTitle,
    promptVersionNumber: g.promptVersionNumber,
    promptVariables: parseValues(g.promptVariables),
  }));
}

const refRow = (generationId: string, position: number, ref: GenerationFileRef) => ({
  generationId,
  position,
  fileId: ref.fileId,
  sha256: ref.sha256,
  originalName: ref.originalName,
});

const isRetired = inArray(generation.status, ['failed', 'cancelled']);

export function createGenerationRepository(db: BetterSQLite3Database): GenerationRepository {
  const read = <T>(work: (tx: Tx) => T): T => db.transaction(work, { behavior: 'deferred' });
  const first = (where: SQL): GenerationRow | null => read((tx) => load(tx, where, [], 1)[0] ?? null);

  /** Synchronous, so it can run inside a job repository transaction on the same connection. */
  const settle = ({ id, outcome, now }: { id: string; outcome: JobOutcome; now: string }): boolean => {
    const end =
      outcome.status === 'cancelled'
        ? { status: 'cancelled' as const, errorCode: null }
        : outcome.status === 'failed'
          ? { status: 'failed' as const, errorCode: outcome.errorCode }
          : // A succeeded job whose generation is still pending never linked its result.
            { status: 'failed' as const, errorCode: 'internal_error' as const };
    return (
      db
        .update(generation)
        .set({ ...end, finishedAt: now })
        .where(and(eq(generation.id, id), eq(generation.status, 'pending')))
        .run().changes > 0
    );
  };

  return {
    async create({ generation: g, input, job: j }): Promise<void> {
      db.transaction((tx) => {
        tx.insert(generation)
          .values({
            id: g.id,
            kind: g.kind,
            status: 'pending',
            errorCode: null,
            providerId: g.providerId,
            providerName: g.providerName,
            providerKind: g.providerKind,
            model: g.model,
            prompt: g.prompt,
            parameters: JSON.stringify(g.parameters),
            jobId: j.id,
            createdAt: g.createdAt,
            finishedAt: null,
            promptVersionId: g.promptRef?.versionId ?? null,
            promptTitle: g.promptRef?.title ?? null,
            promptVersionNumber: g.promptRef?.versionNumber ?? null,
            promptVariables: g.promptRef ? JSON.stringify({ v: 1, values: g.promptRef.variables }) : null,
          })
          .run();
        tx.insert(generationInput).values(refRow(g.id, 0, input)).run();
        // A skipped job (file gone or trashed) rolls the whole transaction back.
        if (!insertJob(tx, j, g.createdAt)) throw new Error('The generation job was not inserted');
      });
    },
    async get(id) {
      return first(eq(generation.id, id));
    },
    async byJob(jobId) {
      return first(eq(generation.jobId, jobId));
    },
    async madeBy(fileId) {
      const wroteTheFile = sql`exists (select 1 from ${generationOutput} where ${generationOutput.generationId} = ${generation.id} and ${generationOutput.fileId} = ${fileId})`;
      return first(wroteTheFile);
    },
    async resultsOf(fileId, limit) {
      const readTheFile = sql`exists (select 1 from ${generationInput} where ${generationInput.generationId} = ${generation.id} and ${generationInput.fileId} = ${fileId})`;
      return read((tx) => load(tx, readTheFile, [desc(generation.createdAt), desc(generation.id)], limit));
    },
    async editRank(id) {
      return read((tx) => {
        const row = tx
          .select({ kind: generation.kind, createdAt: generation.createdAt, fileId: generationInput.fileId })
          .from(generation)
          .innerJoin(generationInput, and(eq(generationInput.generationId, generation.id), eq(generationInput.position, 0)))
          .where(eq(generation.id, id))
          .get();
        // A purged input file no longer tells which edits belong together.
        if (!row || row.kind !== 'edit' || row.fileId === null) return 0;
        const before = tx
          .select({ n: count() })
          .from(generation)
          .innerJoin(generationInput, eq(generationInput.generationId, generation.id))
          .where(
            and(
              eq(generation.kind, 'edit'),
              eq(generationInput.fileId, row.fileId),
              or(lt(generation.createdAt, row.createdAt), and(eq(generation.createdAt, row.createdAt), lt(generation.id, id))),
            ),
          )
          .get();
        return (before?.n ?? 0) + 1;
      });
    },
    async succeed({ id, output, now }): Promise<boolean> {
      return db.transaction((tx) => {
        const changed =
          tx
            .update(generation)
            .set({ status: 'succeeded', errorCode: null, finishedAt: now })
            .where(and(eq(generation.id, id), eq(generation.status, 'pending')))
            .run().changes > 0;
        if (!changed) return false;
        const next = tx
          .select({ n: count() })
          .from(generationOutput)
          .where(eq(generationOutput.generationId, id))
          .get();
        tx.insert(generationOutput).values(refRow(id, next?.n ?? 0, output)).run();
        return true;
      });
    },
    settle,
    async requeue({ id, job: j, now }): Promise<boolean> {
      return db.transaction((tx) => {
        const row = tx.select({ id: generation.id }).from(generation).where(and(eq(generation.id, id), isRetired)).get();
        if (!row) return false;
        if (!insertJob(tx, j, now)) return false;
        tx.update(generation)
          .set({ status: 'pending', errorCode: null, finishedAt: null, jobId: j.id })
          .where(eq(generation.id, id))
          .run();
        return true;
      });
    },
    async remove(id): Promise<boolean> {
      // The input and output rows go with it through their `cascade` rule.
      return db.delete(generation).where(and(eq(generation.id, id), isRetired)).run().changes > 0;
    },
    async recentPrompts(limit): Promise<string[]> {
      // The newest use of each distinct prompt, then the newest of those first.
      const uses = db
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
      return db
        .select({ prompt: uses.prompt })
        .from(uses)
        .where(eq(uses.rank, 1))
        .orderBy(desc(uses.createdAt), desc(uses.id))
        .limit(limit)
        .all()
        .flatMap((r) => (r.prompt === null ? [] : [r.prompt]));
    },
    async reconcile(now): Promise<number> {
      return db.transaction((tx) => {
        const pending = tx
          .select({ id: generation.id, jobStatus: job.status, jobErrorCode: job.errorCode })
          .from(generation)
          .leftJoin(job, eq(job.id, generation.jobId))
          .where(eq(generation.status, 'pending'))
          .all();
        let changed = 0;
        for (const p of pending) {
          let outcome: JobOutcome;
          if (p.jobStatus === null) outcome = { status: 'failed', errorCode: 'provider_outcome_unknown' };
          else if (!isFinishedJob(p.jobStatus)) continue;
          else if (p.jobStatus === 'failed') outcome = { status: 'failed', errorCode: errorCodeOf(p.jobErrorCode) ?? 'internal_error' };
          else if (p.jobStatus === 'cancelled') outcome = { status: 'cancelled' };
          else outcome = { status: 'succeeded' };
          if (settle({ id: p.id, outcome, now })) changed++;
        }
        return changed;
      });
    },
  };
}
