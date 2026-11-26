import {
  ACTIVE_JOB_STATUSES,
  FINISHED_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobStatusSchema,
  type JobErrorCode,
  type JobStatus,
  type JobView,
} from '@assetforge/contracts';
import type { Job, NewJob } from '../src/jobs.js';
import type { JobRepository } from '../src/ports.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Oldest created_at first, then id. */
const oldestFirst = (a: Job, b: Job) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

const isActive = (status: JobStatus) => (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
const errorOf = (code: JobErrorCode | null) => ({ errorCode: code, errorMessage: code === null ? null : JOB_ERROR_MESSAGES[code] });

/** The job queue over an array, following the contract of the SQLite repository. */
export class InMemoryJobRepository implements JobRepository {
  /** Stored rows; callers may inspect them. Every method returns copies. */
  readonly rows: Job[] = [];

  /** `fileName(id)` supplies the original name of a job's file for `list`. */
  constructor(private readonly fileName: (fileId: string) => string | null = () => null) {}

  private keyHeld(dedupeKey: string): boolean {
    return this.rows.some((r) => r.dedupeKey === dedupeKey && isActive(r.status));
  }

  /** Applies `patch` to the job if it is `running`. */
  private fromRunning(id: string, patch: Partial<Job>): boolean {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== 'running') return false;
    Object.assign(row, patch);
    return true;
  }

  async enqueue({ jobs, now }: { jobs: readonly NewJob[]; now: string }): Promise<string[]> {
    const inserted: string[] = [];
    for (const j of jobs) {
      if (j.dedupeKey !== null && this.keyHeld(j.dedupeKey)) continue;
      if (this.rows.some((r) => r.id === j.id)) throw new Error('UNIQUE constraint failed: job.id');
      this.rows.push({
        ...j,
        payload: structuredClone(j.payload),
        status: 'queued',
        attempt: 0,
        runAfter: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      });
      inserted.push(j.id);
    }
    return inserted;
  }

  async get(id: string): Promise<Job | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? structuredClone(row) : null;
  }

  async latestForFile(fileId: string, type: string): Promise<Job | null> {
    const newest = this.rows
      .filter((r) => r.fileId === fileId && r.type === type)
      .sort((a, b) => oldestFirst(b, a))[0];
    return newest ? structuredClone(newest) : null;
  }

  async listByStatus(status: JobStatus): Promise<Job[]> {
    return this.rows.filter((r) => r.status === status).sort(oldestFirst).map((r) => structuredClone(r));
  }

  async claimNext({ resourceClass, types, now }: { resourceClass: Job['resourceClass']; types: readonly string[]; now: string }): Promise<Job | null> {
    const next = this.rows
      .filter(
        (r) =>
          r.resourceClass === resourceClass &&
          types.includes(r.type) &&
          (r.status === 'queued' || (r.status === 'retry_wait' && r.runAfter !== null && r.runAfter <= now)),
      )
      .sort(oldestFirst)[0];
    if (!next) return null;
    Object.assign(next, { status: 'running', attempt: next.attempt + 1, startedAt: now, runAfter: null, ...errorOf(null), updatedAt: now });
    return structuredClone(next);
  }

  async nextRunAfter(types: readonly string[]): Promise<string | null> {
    const times = this.rows
      .filter((r) => r.status === 'retry_wait' && types.includes(r.type) && r.runAfter !== null)
      .map((r) => r.runAfter!)
      .sort(cmp);
    return times[0] ?? null;
  }

  async finish(id: string, r: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode: JobErrorCode | null; now: string }): Promise<boolean> {
    return this.fromRunning(id, { status: r.status, ...errorOf(r.errorCode), finishedAt: r.now, updatedAt: r.now });
  }

  async scheduleRetry(id: string, r: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean> {
    return this.fromRunning(id, { status: 'retry_wait', ...errorOf(r.errorCode), runAfter: r.runAfter, updatedAt: r.now });
  }

  async release(id: string, now: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    return this.fromRunning(id, { status: 'queued', attempt: Math.max((row?.attempt ?? 0) - 1, 0), startedAt: null, updatedAt: now });
  }

  async cancelPending({ id, now }: { id?: string; now: string }): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (id !== undefined && row.id !== id) continue;
      if (row.status !== 'queued' && row.status !== 'retry_wait' && row.status !== 'waiting_remote') continue;
      Object.assign(row, { status: 'cancelled', finishedAt: now, updatedAt: now });
      n++;
    }
    return n;
  }

  async retry({ id, now }: { id?: string; now: string }): Promise<number> {
    const candidates = this.rows
      .filter((r) => (id === undefined || r.id === id) && (r.status === 'failed' || r.status === 'cancelled'))
      .sort((a, b) => oldestFirst(b, a));
    let n = 0;
    for (const row of candidates) {
      if (row.dedupeKey !== null && this.keyHeld(row.dedupeKey)) continue;
      Object.assign(row, { status: 'queued', attempt: 0, ...errorOf(null), runAfter: null, startedAt: null, finishedAt: null, updatedAt: now });
      n++;
    }
    return n;
  }

  async clearFinished(): Promise<number> {
    const before = this.rows.length;
    const kept = this.rows.filter((r) => !(FINISHED_JOB_STATUSES as readonly JobStatus[]).includes(r.status));
    this.rows.splice(0, this.rows.length, ...kept);
    return before - kept.length;
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const result = Object.fromEntries(JobStatusSchema.options.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const row of this.rows) result[row.status]++;
    return result;
  }

  async list(q: { limit: number; offset: number; status?: JobStatus }): Promise<{ items: JobView[]; total: number }> {
    const matching = this.rows.filter((r) => q.status === undefined || r.status === q.status).sort((a, b) => oldestFirst(b, a));
    const items = matching.slice(q.offset, q.offset + q.limit).map(
      (r): JobView => ({
        id: r.id,
        type: r.type,
        status: r.status,
        attempt: r.attempt,
        fileId: r.fileId,
        fileName: r.fileId === null ? null : this.fileName(r.fileId),
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        runAfter: r.runAfter,
      }),
    );
    return { items, total: matching.length };
  }
}
