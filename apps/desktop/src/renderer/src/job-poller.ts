import type { Changes, JobSummary } from '@assetforge/contracts';
import { call } from './api';

/** What the poller hands on. */
export interface JobPollerHandlers {
  /** Takes every answered summary. */
  summarised(summary: JobSummary): void;
  /** Takes every answer of `changes:since`. */
  changed(changes: Changes): void;
}

/**
 * Polls `jobs:summary` one request at a time: at once on `poll()`, then `intervalMs` after each answer settled. After
 * the first answer and every one in which `changes` moved it asks `changes:since` inside the same cycle, so the next
 * poll is scheduled only once that request has settled. A failed poll keeps nothing and the next tick polls again.
 */
export class JobPoller {
  private disposed = false;
  private inFlight = false;
  // A refresh while a poll runs: poll again as soon as it ends.
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // `changes` of the last answered summary; null before the first one.
  private lastChanges: number | null = null;
  // The cursor of the last change answer; null asks for a fresh one (answered with `reset`).
  private cursor: string | null = null;
  // A change request failed: the next poll asks again with the same cursor, so nothing is lost.
  private owed = false;

  /**
   * @param handlers where the summaries and change answers go
   * @param intervalMs the pause between the end of one poll and the next
   */
  constructor(
    private readonly handlers: JobPollerHandlers,
    private readonly intervalMs: number,
  ) {}

  /** Polls now; while a poll runs, polls again as soon as it ends. Does nothing once disposed. */
  poll(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    this.again = false;
    call('jobs:summary', {})
      .then(
        (next) => this.takeSummary(next),
        // The last state stays; the next tick tries again.
        () => {},
      )
      .finally(() => {
        this.inFlight = false;
        if (this.disposed) return;
        this.schedule(this.again ? 0 : this.intervalMs);
      });
  }

  /** Stops polling; answers still under way are dropped. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }

  /**
   * Hands an answered summary on and, when `changes` moved (or a change request is owed), reads the changes.
   *
   * @param next the answered summary
   * @returns the change request when one is made, else undefined
   */
  private takeSummary(next: JobSummary): Promise<void> | undefined {
    if (this.disposed) return undefined;
    const changed = this.lastChanges === null || next.changes !== this.lastChanges;
    this.lastChanges = next.changes;
    this.handlers.summarised(next);
    // Inside the poll cycle: the next poll is scheduled once this request has settled.
    return changed || this.owed ? this.readChanges() : undefined;
  }

  /**
   * Asks `changes:since` once and hands the answer on; a failure keeps the cursor.
   *
   * @returns resolves once the request settled
   */
  private readChanges(): Promise<void> {
    return call('changes:since', { cursor: this.cursor }).then(
      (changes) => {
        if (this.disposed) return;
        this.cursor = changes.cursor;
        this.owed = false;
        this.handlers.changed(changes);
      },
      () => {
        this.owed = true;
      },
    );
  }

  /**
   * Schedules the next poll.
   *
   * @param delayMs the delay
   */
  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => this.poll(), delayMs);
  }
}
