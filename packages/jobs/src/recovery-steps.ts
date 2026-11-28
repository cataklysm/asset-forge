import { MAX_ATTEMPTS } from '@assetforge/contracts';

/**
 * What the recovery does with a row found `running` that this scheduler does not run:
 * - `release`: back to `queued` with its attempt given back;
 * - `fail`: ended as failed with the handler's interrupted code;
 * - `retry`: back to waiting with its attempt spent, due at once;
 * - `exhausted`: ended as failed with the interrupted code, because its last attempt is spent.
 */
export type RecoveryStep = 'release' | 'fail' | 'retry' | 'exhausted';

/** The rows this scheduler left `running` itself, by why. */
export class LeftoverRows {
  /** Claimed rows whose put-back failed: they never ran, so nothing was sent for them. */
  private readonly unlaunched = new Set<string>();
  /** Rows whose run ended but whose outcome could not be stored: they ran. */
  private readonly unsettled = new Set<string>();

  /**
   * Notes a claimed row that could not be put back.
   *
   * @param jobId the job
   */
  addUnlaunched(jobId: string): void {
    this.unlaunched.add(jobId);
  }

  /**
   * Notes a row whose outcome could not be stored.
   *
   * @param jobId the job
   */
  addUnsettled(jobId: string): void {
    this.unsettled.add(jobId);
  }

  /**
   * Forgets a row once the recovery handled it.
   *
   * @param jobId the job
   */
  forget(jobId: string): void {
    this.unlaunched.delete(jobId);
    this.unsettled.delete(jobId);
  }

  /**
   * Picks the recovery step of a row found `running`.
   *
   * @param job the row's id and attempt (the value after its last claim)
   * @param failsOnInterrupt true when its handler has `onInterrupted: 'fail'`
   * @returns the step; a row that never ran is put back whatever its handler, a row that ran under a `fail` handler
   *   always ends failed, and one that ran under a requeue handler spends its attempt, so a store that keeps failing
   *   cannot rerun it without limit
   */
  stepOf(job: { id: string; attempt: number }, failsOnInterrupt: boolean): RecoveryStep {
    if (this.unlaunched.has(job.id)) return 'release';
    if (failsOnInterrupt) return 'fail';
    if (!this.unsettled.has(job.id)) return 'release';
    return job.attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retry';
  }
}
