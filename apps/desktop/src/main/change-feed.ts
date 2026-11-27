import { randomUUID } from 'node:crypto';
import type { Changes } from '@assetforge/contracts';
import type { JobEffects } from '@assetforge/core';

// Kept free of Electron imports. The changes of the open workspace, in memory and numbered, for `changes:since`:
// the renderer asks after every poll whose summary moved and updates its lists in place. The host clears the feed
// on every workspace open and close, so a cursor of another workspace always answers `reset`.

/** Entries kept; a cursor older than the oldest kept entry answers `reset`. */
export const CHANGE_FEED_CAPACITY = 2000;

export interface ChangeFeed extends JobEffects {
  /** One job row changed. */
  job(id: string): void;
  /** Jobs were added, removed or changed in bulk. */
  jobs(): void;
  /** Forgets every entry and starts a new instance, so every earlier cursor answers `reset`. */
  clear(): void;
  since(cursor: string | null): Changes;
  /** Entries written since the app started; never goes down, `clear` does not reset it. */
  total(): number;
}

type Entry =
  | { kind: 'job'; id: string }
  | { kind: 'jobs' }
  | { kind: 'file'; id: string }
  | { kind: 'added'; assetId: string | null };

const NUMBER = /^(0|[1-9]\d{0,15})$/;

export function createChangeFeed(capacity: number = CHANGE_FEED_CAPACITY): ChangeFeed {
  // The random part keeps a cursor of an earlier app run from ever matching.
  const origin = randomUUID();
  let generation = 0;
  /** The kept entries; `entries[0]` has the number `first`. */
  let entries: Entry[] = [];
  let first = 0;
  let total = 0;

  const instance = () => `${origin}-${generation}`;
  /** The number the next entry gets, which is also the cursor that has seen everything. */
  const next = () => first + entries.length;
  const cursorOf = (n: number) => `${instance()}:${n}`;

  const write = (entry: Entry) => {
    entries.push(entry);
    total += 1;
    const over = entries.length - capacity;
    if (over > 0) {
      entries.splice(0, over);
      first += over;
    }
  };

  /** The entry number of a cursor of this instance that is still covered by the kept entries; null otherwise. */
  const position = (cursor: string | null): number | null => {
    if (cursor === null) return null;
    const at = cursor.lastIndexOf(':');
    if (at <= 0 || cursor.slice(0, at) !== instance()) return null;
    const digits = cursor.slice(at + 1);
    if (!NUMBER.test(digits)) return null;
    const n = Number(digits);
    return n < first || n > next() ? null : n;
  };

  return {
    job: (id) => write({ kind: 'job', id }),
    jobs: () => write({ kind: 'jobs' }),
    fileChanged: (id) => write({ kind: 'file', id }),
    fileAdded: (assetId) => write({ kind: 'added', assetId }),

    clear() {
      generation += 1;
      entries = [];
      first = 0;
    },

    since(cursor) {
      const from = position(cursor);
      const answer: Changes = { cursor: cursorOf(next()), reset: from === null, jobIds: [], jobs: false, fileIds: [], added: [] };
      if (from === null) return answer;
      const jobIds = new Set<string>();
      const fileIds = new Set<string>();
      const added = new Set<string | null>();
      for (const entry of entries.slice(from - first)) {
        if (entry.kind === 'job') jobIds.add(entry.id);
        else if (entry.kind === 'jobs') answer.jobs = true;
        else if (entry.kind === 'file') fileIds.add(entry.id);
        else added.add(entry.assetId);
      }
      answer.jobIds = [...jobIds];
      answer.fileIds = [...fileIds];
      answer.added = [...added].map((assetId) => ({ assetId }));
      return answer;
    },

    total: () => total,
  };
}
