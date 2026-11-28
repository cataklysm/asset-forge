/** How many failed keys one memory keeps; beyond it the oldest is forgotten and tried again when next asked for. */
export const MAX_REMEMBERED_FAILURES = 10_000;

/** Keys that failed this session, at most `limit`, the oldest forgotten first. */
export class FailureMemory {
  /** The remembered keys in the order they were added. */
  private readonly keys = new Set<string>();

  /**
   * @param limit how many keys are kept; at least 1
   * @throws RangeError when `limit` is not an integer of at least 1
   */
  constructor(private readonly limit: number = MAX_REMEMBERED_FAILURES) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('The failure memory limit must be at least 1');
  }

  /**
   * Whether a key is remembered as failed.
   *
   * @param key the key
   * @returns true while the key is remembered
   */
  has(key: string): boolean {
    return this.keys.has(key);
  }

  /**
   * Remembers a key as failed, forgetting the oldest one when the memory is full.
   *
   * @param key the key
   */
  add(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size <= this.limit) return;
    const oldest = this.keys.values().next().value;
    if (oldest !== undefined) this.keys.delete(oldest);
  }

  /**
   * How many keys are remembered.
   *
   * @returns the count
   */
  get size(): number {
    return this.keys.size;
  }
}
