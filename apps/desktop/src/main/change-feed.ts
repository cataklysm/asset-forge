import { randomUUID } from 'node:crypto';
import type { Changes } from '@assetforge/contracts';
import type { JobEffects } from '@assetforge/core';

// Kept free of Electron imports. The changes of the open workspace, in memory and numbered, for `changes:since`:
// the renderer asks after every poll whose summary moved and updates its lists in place. The host clears the feed
// on every workspace open and close, so a cursor of another workspace always answers `reset`.

/** Entries kept; a cursor older than the oldest kept entry answers `reset`. */
export const CHANGE_FEED_CAPACITY = 2000;

/** The numbered changes of the open workspace. */
export interface ChangeFeed extends JobEffects {
  /**
   * One job row changed.
   *
   * @param id the job
   */
  job(id: string): void;
  /** Jobs were added, removed or changed in bulk. */
  jobs(): void;
  /** Forgets every entry and starts a new instance, so every earlier cursor answers `reset`. */
  clear(): void;
  /**
   * What changed since a cursor.
   *
   * @param cursor what an earlier answer gave, or null
   * @returns the changes and the next cursor
   */
  since(cursor: string | null): Changes;
  /** @returns the entries written since the app started; never goes down, `clear` does not reset it */
  total(): number;
}

/** One kept change. */
type Entry =
  | { kind: 'job'; id: string }
  | { kind: 'jobs' }
  | { kind: 'file'; id: string }
  | { kind: 'added'; assetId: string | null };

const NUMBER = /^(0|[1-9]\d{0,15})$/;

/**
 * Creates an empty change feed.
 *
 * @param capacity the entries kept
 * @returns the feed
 */
export function createChangeFeed(capacity: number = CHANGE_FEED_CAPACITY): ChangeFeed {
  const feed = new ChangeEntries(capacity);
  return {
    job: (id) => feed.write({ kind: 'job', id }),
    jobs: () => feed.write({ kind: 'jobs' }),
    fileChanged: (id) => feed.write({ kind: 'file', id }),
    fileAdded: (assetId) => feed.write({ kind: 'added', assetId }),
    clear: () => feed.clear(),
    since: (cursor) => feed.since(cursor),
    total: () => feed.total,
  };
}

/** The kept entries with their numbers. */
class ChangeEntries {
  // The random part keeps a cursor of an earlier app run from ever matching.
  private readonly origin = randomUUID();
  private generation = 0;
  /** The kept entries; `entries[0]` has the number `first`. */
  private entries: Entry[] = [];
  private first = 0;
  /** Entries written since the app started. */
  total = 0;

  /** @param capacity the entries kept */
  constructor(private readonly capacity: number) {}

  /**
   * Adds an entry and drops the oldest ones over the capacity.
   *
   * @param entry the change
   */
  write(entry: Entry): void {
    this.entries.push(entry);
    this.total += 1;
    const over = this.entries.length - this.capacity;
    if (over > 0) {
      this.entries.splice(0, over);
      this.first += over;
    }
  }

  /** Forgets every entry and starts a new instance. */
  clear(): void {
    this.generation += 1;
    this.entries = [];
    this.first = 0;
  }

  /**
   * What changed since a cursor; `reset` for a cursor this instance does not cover.
   *
   * @param cursor what an earlier answer gave, or null
   * @returns the changes and the next cursor
   */
  since(cursor: string | null): Changes {
    const from = this.position(cursor);
    const answer: Changes = { cursor: this.cursorOf(this.next()), reset: from === null, jobIds: [], jobs: false, fileIds: [], added: [] };
    if (from === null) return answer;
    const jobIds = new Set<string>();
    const fileIds = new Set<string>();
    const added = new Set<string | null>();
    for (const entry of this.entries.slice(from - this.first)) {
      if (entry.kind === 'job') jobIds.add(entry.id);
      else if (entry.kind === 'jobs') answer.jobs = true;
      else if (entry.kind === 'file') fileIds.add(entry.id);
      else added.add(entry.assetId);
    }
    answer.jobIds = [...jobIds];
    answer.fileIds = [...fileIds];
    answer.added = [...added].map((assetId) => ({ assetId }));
    return answer;
  }

  /** @returns the name of this instance */
  private instance(): string {
    return `${this.origin}-${this.generation}`;
  }

  /** @returns the number the next entry gets, which is also the cursor that has seen everything */
  private next(): number {
    return this.first + this.entries.length;
  }

  /**
   * @param entryNumber an entry number
   * @returns the cursor of that number in this instance
   */
  private cursorOf(entryNumber: number): string {
    return `${this.instance()}:${entryNumber}`;
  }

  /**
   * The entry number of a cursor of this instance that is still covered by the kept entries; null otherwise.
   *
   * @param cursor the cursor
   * @returns the entry number, or null
   */
  private position(cursor: string | null): number | null {
    if (cursor === null) return null;
    const at = cursor.lastIndexOf(':');
    if (at <= 0 || cursor.slice(0, at) !== this.instance()) return null;
    const digits = cursor.slice(at + 1);
    if (!NUMBER.test(digits)) return null;
    const entryNumber = Number(digits);
    return entryNumber < this.first || entryNumber > this.next() ? null : entryNumber;
  }
}
