/** Runs async operations strictly one after another, in call order. */
export class SerialQueue {
  /** Settles once everything queued so far has settled; never rejects. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `operation` after everything queued before it has settled; a rejection does not stop the queue.
   *
   * @param operation the work to run
   * @returns the outcome of `operation`
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => operation());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
