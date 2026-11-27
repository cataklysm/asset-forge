import type { GenerationFile, GenerationStatus, JobErrorCode } from '@assetforge/contracts';
import type { JobOutcome, NewJob } from '../src/jobs.js';
import type { GenerationFileRef, GenerationRepository, GenerationRow, NewGeneration } from '../src/ports.js';
import { restoreInPlace, type InMemoryJobRepository } from './memory-jobs.js';

interface StoredGeneration extends NewGeneration {
  status: GenerationStatus;
  errorCode: JobErrorCode | null;
  jobId: string | null;
  finishedAt: string | null;
  inputs: GenerationFileRef[];
  outputs: GenerationFileRef[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Oldest created_at first, then id. */
const oldestFirst = (a: StoredGeneration, b: StoredGeneration) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
const isFinishedJob = (status: string) => status === 'succeeded' || status === 'failed' || status === 'cancelled';

/** The generations over an array, following the contract of the SQLite repository. Jobs live in `jobs`. */
export class InMemoryGenerationRepository implements GenerationRepository {
  /** Stored rows; callers may inspect them. Every method returns copies. */
  readonly rows: StoredGeneration[] = [];

  /**
   * `fileState(id)` tells whether a file referenced by an input or output row is live, in the trash or gone
   * (purged); a gone file reads as `fileId: null`, like the `set null` foreign key of the SQLite schema.
   */
  constructor(
    private readonly jobs: InMemoryJobRepository,
    private readonly fileState: (fileId: string) => 'live' | 'trashed' | 'unknown' = () => 'live',
  ) {
    // A `settled` callback that settles a generation is rolled back with the job, as in one SQLite transaction.
    jobs.joinTransactions({ snapshot: () => restoreInPlace(this.rows) });
  }

  private find(id: string): StoredGeneration | undefined {
    return this.rows.find((r) => r.id === id);
  }

  private fileView(ref: GenerationFileRef): GenerationFile {
    const state = this.fileState(ref.fileId);
    return {
      fileId: state === 'unknown' ? null : ref.fileId,
      name: ref.originalName,
      sha256: ref.sha256,
      trashed: state === 'trashed',
    };
  }

  private view(row: StoredGeneration): GenerationRow {
    const job = row.jobId === null ? undefined : this.jobs.rows.find((j) => j.id === row.jobId);
    return structuredClone({
      id: row.id,
      kind: row.kind,
      status: row.status,
      errorCode: row.errorCode,
      providerId: row.providerId,
      providerName: row.providerName,
      providerKind: row.providerKind,
      model: row.model,
      prompt: row.prompt,
      parameters: row.parameters,
      jobId: row.jobId,
      jobStatus: job?.status ?? null,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      inputs: row.inputs.map((f) => this.fileView(f)),
      outputs: row.outputs.map((f) => this.fileView(f)),
    });
  }

  /** Inserts the job; false when the job repository skipped it. */
  private async insertJob(job: NewJob, now: string): Promise<boolean> {
    const inserted = await this.jobs.enqueue({ jobs: [job], now });
    return inserted.includes(job.id);
  }

  async create(r: { generation: NewGeneration; input: GenerationFileRef; job: NewJob }): Promise<void> {
    if (this.find(r.generation.id)) throw new Error('UNIQUE constraint failed: generation.id');
    // A skipped job would roll the whole transaction back.
    if (!(await this.insertJob(r.job, r.generation.createdAt))) throw new Error('The generation job was not inserted');
    this.rows.push({
      ...structuredClone(r.generation),
      status: 'pending',
      errorCode: null,
      jobId: r.job.id,
      finishedAt: null,
      inputs: [{ ...r.input }],
      outputs: [],
    });
  }

  async get(id: string): Promise<GenerationRow | null> {
    const row = this.find(id);
    return row ? this.view(row) : null;
  }

  async byJob(jobId: string): Promise<GenerationRow | null> {
    const row = this.rows.find((r) => r.jobId === jobId);
    return row ? this.view(row) : null;
  }

  async madeBy(fileId: string): Promise<GenerationRow | null> {
    const row = this.rows.find((r) => r.outputs.some((o) => o.fileId === fileId));
    return row ? this.view(row) : null;
  }

  async resultsOf(fileId: string, limit: number): Promise<GenerationRow[]> {
    return this.rows
      .filter((r) => r.inputs.some((i) => i.fileId === fileId))
      .sort((a, b) => oldestFirst(b, a))
      .slice(0, limit)
      .map((r) => this.view(r));
  }

  async editRank(id: string): Promise<number> {
    const row = this.find(id);
    const inputId = row?.inputs[0]?.fileId;
    if (!row || row.kind !== 'edit' || inputId === undefined) return 0;
    const edits = this.rows.filter((r) => r.kind === 'edit' && r.inputs.some((i) => i.fileId === inputId)).sort(oldestFirst);
    return edits.indexOf(row) + 1;
  }

  async succeed(r: { id: string; output: GenerationFileRef; now: string }): Promise<boolean> {
    const row = this.find(r.id);
    if (!row || row.status !== 'pending') return false;
    Object.assign(row, { status: 'succeeded', errorCode: null, finishedAt: r.now, outputs: [...row.outputs, { ...r.output }] });
    return true;
  }

  settle(r: { id: string; outcome: JobOutcome; now: string }): boolean {
    const row = this.find(r.id);
    if (!row || row.status !== 'pending') return false;
    const { outcome } = r;
    if (outcome.status === 'cancelled') Object.assign(row, { status: 'cancelled', errorCode: null });
    else if (outcome.status === 'failed') Object.assign(row, { status: 'failed', errorCode: outcome.errorCode });
    // A succeeded job whose generation is still pending never linked its result.
    else Object.assign(row, { status: 'failed', errorCode: 'internal_error' });
    row.finishedAt = r.now;
    return true;
  }

  async requeue(r: { id: string; job: NewJob; now: string }): Promise<boolean> {
    const row = this.find(r.id);
    if (!row || (row.status !== 'failed' && row.status !== 'cancelled')) return false;
    if (!(await this.insertJob(r.job, r.now))) return false;
    Object.assign(row, { status: 'pending', errorCode: null, finishedAt: null, jobId: r.job.id });
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const row = this.find(id);
    if (!row || (row.status !== 'failed' && row.status !== 'cancelled')) return false;
    this.rows.splice(this.rows.indexOf(row), 1);
    return true;
  }

  async recentPrompts(limit: number): Promise<string[]> {
    const prompts: string[] = [];
    for (const row of [...this.rows].sort((a, b) => oldestFirst(b, a))) {
      if (prompts.length >= limit) break;
      if (row.kind === 'edit' && row.prompt !== null && !prompts.includes(row.prompt)) prompts.push(row.prompt);
    }
    return prompts;
  }

  async reconcile(now: string): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (row.status !== 'pending') continue;
      const job = row.jobId === null ? undefined : this.jobs.rows.find((j) => j.id === row.jobId);
      let outcome: JobOutcome;
      if (job === undefined) outcome = { status: 'failed', errorCode: 'provider_outcome_unknown' };
      else if (!isFinishedJob(job.status)) continue;
      else if (job.status === 'failed') outcome = { status: 'failed', errorCode: job.errorCode ?? 'internal_error' };
      else if (job.status === 'cancelled') outcome = { status: 'cancelled' };
      else outcome = { status: 'succeeded' };
      if (this.settle({ id: row.id, outcome, now })) n++;
    }
    return n;
  }
}
