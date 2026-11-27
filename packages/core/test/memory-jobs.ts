import {
  ACTIVE_JOB_STATUSES,
  FILE_DOWNLOAD_JOB,
  FINISHED_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobStatusSchema,
  analysisJobFields,
  downloadJobFields,
  type JobErrorCode,
  type JobResult,
  type JobStatus,
  type JobView,
} from '@assetforge/contracts';
import type { Job, NewJob } from '../src/jobs.js';
import type { JobRepository } from '../src/ports.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Oldest created_at first, then id. */
const oldestFirst = (a: Job, b: Job) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

const isActive = (status: JobStatus) => (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
const isWaiting = (status: JobStatus) => status === 'queued' || status === 'retry_wait';
const errorOf = (code: JobErrorCode | null) => ({ errorCode: code, errorMessage: code === null ? null : JOB_ERROR_MESSAGES[code] });
const notExcluded = (excludeLanes: readonly (string | null)[] | undefined) => (r: Job) => !(excludeLanes ?? []).includes(r.lane);

/**
 * Snapshots `rows` and answers a function that puts them back as they were. Restores in place, so
 * references callers hold to a row stay valid.
 */
export function restoreInPlace<T extends object>(rows: T[]): () => void {
  const before = rows.map((row) => [row, structuredClone(row)] as const);
  return () => {
    rows.splice(0, rows.length, ...before.map(([row, copy]) => Object.assign(row, copy)));
  };
}

/** The job queue over an array, following the contract of the SQLite repository. */
export class InMemoryJobRepository implements JobRepository {
  /** Stored rows; callers may inspect them. Every method returns copies. */
  readonly rows: Job[] = [];
  /** The stored `result` column by job id; a job without an entry has null. */
  readonly results = new Map<string, JobResult>();

  /**
   * `fileName(id)` supplies the original name of a job's file for `list`. With `fileState`, `enqueue`
   * skips a job whose file is unknown or in the trash and `retry` skips a job whose file is in the
   * trash, like the SQLite repository; without it every file counts as live.
   */
  constructor(
    private readonly fileName: (fileId: string) => string | null = () => null,
    private readonly fileState: (fileId: string) => 'live' | 'trashed' | 'unknown' = () => 'live',
  ) {}

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
      if (j.fileId !== null && this.fileState(j.fileId) !== 'live') continue;
      if (this.rows.some((r) => r.id === j.id)) throw new Error('UNIQUE constraint failed: job.id');
      this.rows.push({
        ...j,
        // The SQLite column is nullable; a caller that leaves the lane out stores null.
        lane: j.lane ?? null,
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
    const newestFirst = this.rows.filter((r) => r.fileId === fileId && r.type === type).sort((a, b) => oldestFirst(b, a));
    const chosen = newestFirst.find((r) => isActive(r.status)) ?? newestFirst[0];
    return chosen ? structuredClone(chosen) : null;
  }

  async activeForFile(fileId: string): Promise<Job[]> {
    return this.rows.filter((r) => r.fileId === fileId && isActive(r.status)).sort(oldestFirst).map((r) => structuredClone(r));
  }

  async listByStatus(status: JobStatus): Promise<Job[]> {
    return this.rows.filter((r) => r.status === status).sort(oldestFirst).map((r) => structuredClone(r));
  }

  async claimNext({
    resourceClass,
    types,
    now,
    excludeLanes,
  }: {
    resourceClass: Job['resourceClass'];
    types: readonly string[];
    now: string;
    excludeLanes?: readonly (string | null)[];
  }): Promise<Job | null> {
    const next = this.rows
      .filter(
        (r) =>
          r.resourceClass === resourceClass &&
          types.includes(r.type) &&
          (r.status === 'queued' || (r.status === 'retry_wait' && r.runAfter !== null && r.runAfter <= now)),
      )
      .filter(notExcluded(excludeLanes))
      .sort(oldestFirst)[0];
    if (!next) return null;
    Object.assign(next, { status: 'running', attempt: next.attempt + 1, startedAt: now, runAfter: null, ...errorOf(null), updatedAt: now });
    return structuredClone(next);
  }

  async nextRunAfter(types: readonly string[], excludeLanes?: readonly (string | null)[]): Promise<string | null> {
    const times = this.rows
      .filter((r) => r.status === 'retry_wait' && types.includes(r.type) && r.runAfter !== null)
      .filter(notExcluded(excludeLanes))
      .map((r) => r.runAfter!)
      .sort(cmp);
    return times[0] ?? null;
  }

  async finish(
    id: string,
    r: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode: JobErrorCode | null; now: string; settled?: () => void },
  ): Promise<boolean> {
    return this.inTransaction(() => {
      const changed = this.fromRunning(id, { status: r.status, ...errorOf(r.errorCode), finishedAt: r.now, updatedAt: r.now });
      if (changed) r.settled?.();
      return changed;
    });
  }

  /** Other in-memory stores rolled back with a job transaction; `snapshot` answers the restore. */
  private readonly participants: { snapshot(): () => void }[] = [];

  /** Lets another in-memory store (the generations) take part in the transactions of `finish` and `cancelPending`. */
  joinTransactions(participant: { snapshot(): () => void }): void {
    this.participants.push(participant);
  }

  /** Runs `work` like a transaction: when it throws, every row (also of the participants) is put back as it was. */
  private inTransaction<T>(work: () => T): T {
    const restores = [restoreInPlace(this.rows), ...this.participants.map((p) => p.snapshot())];
    try {
      return work();
    } catch (error) {
      for (const restore of restores) restore();
      throw error;
    }
  }

  async scheduleRetry(id: string, r: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean> {
    return this.fromRunning(id, { status: 'retry_wait', ...errorOf(r.errorCode), runAfter: r.runAfter, updatedAt: r.now });
  }

  async setOutcome(id: string, r: { fileId: string | null; result: JobResult | null; now: string }): Promise<boolean> {
    if (r.fileId !== null && this.fileState(r.fileId) === 'unknown') return false;
    if (!this.fromRunning(id, { fileId: r.fileId, updatedAt: r.now })) return false;
    if (r.result === null) this.results.delete(id);
    else this.results.set(id, r.result);
    return true;
  }

  async holdLane(r: { types: readonly string[]; lane: string | null; until: string; now: string }): Promise<number> {
    const held = this.rows.filter(
      (row) =>
        r.types.includes(row.type) && row.lane === r.lane && isWaiting(row.status) && (row.runAfter === null || row.runAfter < r.until),
    );
    for (const row of held) Object.assign(row, { status: 'retry_wait', runAfter: r.until, updatedAt: r.now });
    return held.length;
  }

  async release(id: string, now: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    return this.fromRunning(id, { status: 'queued', attempt: Math.max((row?.attempt ?? 0) - 1, 0), startedAt: null, updatedAt: now });
  }

  async cancelPending({ id, now, settled }: { id?: string; now: string; settled?: (job: Job) => void }): Promise<number> {
    return this.inTransaction(() => {
      let n = 0;
      for (const row of this.rows) {
        if (id !== undefined && row.id !== id) continue;
        if (row.status !== 'queued' && row.status !== 'retry_wait' && row.status !== 'waiting_remote') continue;
        Object.assign(row, { status: 'cancelled', finishedAt: now, updatedAt: now });
        settled?.(structuredClone(row));
        n++;
      }
      return n;
    });
  }

  async cancelPendingOfFile({
    fileId,
    refuseRunning,
    now,
    settled,
  }: {
    fileId: string;
    refuseRunning: readonly string[];
    now: string;
    settled?: (job: Job) => void;
  }): Promise<{ refused: boolean; cancelled: number }> {
    return this.inTransaction(() => {
      const ofFile = this.rows.filter((r) => r.fileId === fileId);
      if (ofFile.some((r) => r.status === 'running' && refuseRunning.includes(r.type))) return { refused: true, cancelled: 0 };
      let cancelled = 0;
      for (const row of ofFile) {
        if (row.status !== 'queued' && row.status !== 'retry_wait' && row.status !== 'waiting_remote') continue;
        Object.assign(row, { status: 'cancelled', finishedAt: now, updatedAt: now });
        settled?.(structuredClone(row));
        cancelled++;
      }
      return { refused: false, cancelled };
    });
  }

  async retry({ id, now, excludeTypes }: { id?: string; now: string; excludeTypes?: readonly string[] }): Promise<number> {
    const candidates = this.rows
      .filter((r) => (id === undefined || r.id === id) && (r.status === 'failed' || r.status === 'cancelled'))
      .filter((r) => !(excludeTypes ?? []).includes(r.type))
      .filter((r) => r.fileId === null || this.fileState(r.fileId) !== 'trashed')
      .sort((a, b) => oldestFirst(b, a));
    let n = 0;
    for (const row of candidates) {
      if (row.dedupeKey !== null && this.keyHeld(row.dedupeKey)) continue;
      Object.assign(row, { status: 'queued', attempt: 0, ...errorOf(null), runAfter: null, startedAt: null, finishedAt: null, updatedAt: now });
      if (row.type === FILE_DOWNLOAD_JOB) row.fileId = null;
      this.results.delete(row.id);
      n++;
    }
    return n;
  }

  async clearFinished(): Promise<number> {
    const before = this.rows.length;
    const kept = this.rows.filter((r) => !(FINISHED_JOB_STATUSES as readonly JobStatus[]).includes(r.status));
    this.rows.splice(0, this.rows.length, ...kept);
    for (const id of [...this.results.keys()]) if (!kept.some((r) => r.id === id)) this.results.delete(id);
    return before - kept.length;
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const result = Object.fromEntries(JobStatusSchema.options.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const row of this.rows) result[row.status]++;
    return result;
  }

  async list(q: { limit: number; offset: number; status?: JobStatus; lane?: string }): Promise<{ items: JobView[]; total: number }> {
    const matching = this.rows
      .filter((r) => (q.status === undefined || r.status === q.status) && (q.lane === undefined || r.lane === q.lane))
      .sort((a, b) => oldestFirst(b, a));
    const items = matching.slice(q.offset, q.offset + q.limit).map((r): JobView => {
      const download = r.type === FILE_DOWNLOAD_JOB;
      return {
        ...(download ? { providerName: null, model: null } : analysisJobFields(r.payload)),
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
        // A download's lane is its host, not a provider.
        providerId: download ? null : r.lane,
        ...(download ? downloadJobFields(r.payload) : { url: null, host: null }),
        result: this.results.get(r.id) ?? null,
      };
    });
    return { items, total: matching.length };
  }

  async waitingByLane(type: string): Promise<{ lane: string | null; waiting: number }[]> {
    const counts = new Map<string | null, number>();
    for (const r of this.rows) {
      if (r.type === type && isWaiting(r.status)) counts.set(r.lane, (counts.get(r.lane) ?? 0) + 1);
    }
    return [...counts].map(([lane, waiting]) => ({ lane, waiting }));
  }

  async latestPayloadOfLane(type: string, lane: string | null): Promise<unknown | null> {
    const newest = this.rows.filter((r) => r.type === type && r.lane === lane).sort((a, b) => oldestFirst(b, a))[0];
    return newest ? structuredClone(newest.payload) : null;
  }

  async countActiveInLane(type: string, lane: string): Promise<number> {
    return this.rows.filter((r) => r.type === type && r.lane === lane && isActive(r.status)).length;
  }

  async rerouteWaiting(r: {
    type: string;
    fromLane: string | null;
    toLane: string;
    rewrite: (payload: unknown) => unknown;
    now: string;
  }): Promise<number> {
    const moving = this.rows.filter((row) => row.type === r.type && row.lane === r.fromLane && isWaiting(row.status));
    // Rewrite every payload first, so a throwing rewrite changes nothing, as a rolled-back transaction would.
    const payloads = moving.map((row) => structuredClone(r.rewrite(structuredClone(row.payload))));
    moving.forEach((row, i) => {
      Object.assign(row, {
        lane: r.toLane,
        payload: payloads[i],
        status: 'queued',
        attempt: 0,
        runAfter: null,
        ...errorOf(null),
        updatedAt: r.now,
      });
    });
    return moving.length;
  }

  async assignLane(r: { type: string; lane: string; rewrite: (payload: unknown) => unknown | null; now: string }): Promise<number> {
    const candidates = this.rows.filter((row) => row.type === r.type && row.lane === null && isActive(row.status));
    const changes = candidates
      .map((row) => ({ row, payload: r.rewrite(structuredClone(row.payload)) }))
      .filter((c) => c.payload !== null);
    for (const { row, payload } of changes) {
      Object.assign(row, { lane: r.lane, payload: structuredClone(payload), updatedAt: r.now });
    }
    return changes.length;
  }
}
