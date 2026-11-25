/** Runs async operations strictly one after another, in call order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after everything queued before it has settled; a rejection does not stop the queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
