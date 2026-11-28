// The restores in progress, so quitting or closing the main window can abort the copy of their backup.

/** Holds one abort controller per running restore. */
export class RunningRestores {
  /** The controllers of the restores in progress. */
  private readonly controllers = new Set<AbortController>();

  /**
   * Runs a restore with a signal that `abortAll` aborts.
   *
   * @param restore the restore, given its signal
   * @returns what the restore answered
   */
  async run<T>(restore: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await restore(controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** Aborts every restore in progress; a restore whose copy is done finishes anyway. */
  abortAll(): void {
    for (const controller of this.controllers) controller.abort();
  }

  /**
   * How many restores are in progress.
   *
   * @returns the count
   */
  get size(): number {
    return this.controllers.size;
  }
}
