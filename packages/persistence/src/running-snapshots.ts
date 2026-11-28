/**
 * The snapshots running on one connection, so its close can stop them first. A snapshot stopped this way rejects with
 * `backup_failed` within one backup step (or at once during its check) and has removed its copy, or handed the removal
 * to the exit of its check worker, by the time it settles.
 */
export class RunningSnapshots {
  /** The stop of every running snapshot, by its promise. */
  private readonly running = new Map<Promise<unknown>, AbortController>();

  /**
   * Runs a snapshot that the next `stopAll` stops too.
   *
   * @param signal the caller's abort signal
   * @param run starts the snapshot with the combined signal
   * @returns the snapshot's promise
   */
  track<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const snapshot = run(AbortSignal.any([signal, stop.signal]));
    this.running.set(snapshot, stop);
    void snapshot.then(
      () => this.running.delete(snapshot),
      () => this.running.delete(snapshot),
    );
    return snapshot;
  }

  /**
   * Stops every running snapshot and waits until each has settled.
   *
   * @returns resolves once no snapshot runs; never rejects
   */
  async stopAll(): Promise<void> {
    const snapshots = [...this.running.entries()];
    for (const [, stop] of snapshots) stop.abort(new Error('The database is being closed'));
    await Promise.allSettled(snapshots.map(([snapshot]) => snapshot));
  }
}
