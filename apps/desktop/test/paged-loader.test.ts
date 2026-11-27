import { describe, expect, it } from 'vitest';
import { MAX_IN_FLIGHT, PAGE_SIZE, slotAt } from '../src/renderer/src/paged-list.js';
import { PagedLoader } from '../src/renderer/src/paged-loader.js';

interface Call {
  offset: number;
  resolve(total: number): void;
  reject(): void;
}

function harness(key = 'A') {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let changes = 0;
  const loader = new PagedLoader<number>(key, {
    fetchPage: (offset, limit) =>
      new Promise((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const settle = () => (inFlight -= 1);
        calls.push({
          offset,
          resolve: (total) => {
            settle();
            const end = Math.min(offset + limit, total);
            resolve({ items: Array.from({ length: Math.max(0, end - offset) }, (_, i) => offset + i), total });
          },
          reject: () => {
            settle();
            reject(new Error('boom'));
          },
        });
      }),
    onChange: () => (changes += 1),
  });
  loader.setActive(true);
  return {
    loader,
    calls,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get changes() {
      return changes;
    },
  };
}

/** Answers every request on its own with a list of `total` items. */
function autoHarness(total: number) {
  const offsets: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const loader = new PagedLoader<number>('A', {
    fetchPage: async (offset, limit) => {
      offsets.push(offset);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      const end = Math.min(offset + limit, total);
      return { items: Array.from({ length: Math.max(0, end - offset) }, (_, i) => offset + i), total };
    },
    onChange: () => {},
  });
  loader.setActive(true);
  return {
    loader,
    offsets,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Row {
  id: string;
  /** The index of the request that answered this row, so a refetched page can be told apart. */
  call: number;
}

/** Like `harness`, with records that carry an id; `open` lists the calls not yet answered. */
function rowHarness(key = 'A') {
  const calls: (Call & { settled: boolean })[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let changes = 0;
  const loader = new PagedLoader<Row>(key, {
    fetchPage: (offset, limit) =>
      new Promise((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const call = calls.length;
        const entry = {
          offset,
          settled: false,
          resolve: (total: number) => {
            entry.settled = true;
            inFlight -= 1;
            const end = Math.min(offset + limit, total);
            resolve({
              items: Array.from({ length: Math.max(0, end - offset) }, (_, i) => ({ id: `r${offset + i}`, call })),
              total,
            });
          },
          reject: () => {
            entry.settled = true;
            inFlight -= 1;
            reject(new Error('boom'));
          },
        };
        calls.push(entry);
      }),
    onChange: () => (changes += 1),
  });
  loader.setActive(true);
  return {
    loader,
    calls,
    get open() {
      return calls.filter((c) => !c.settled);
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get changes() {
      return changes;
    },
  };
}

/** Wants `pages` and answers every request with `total` until nothing is open any more. */
async function loadPages(h: ReturnType<typeof rowHarness>, pages: number[], total: number): Promise<void> {
  h.loader.setWanted(pages);
  for (let open = h.open; open.length > 0; open = h.open) {
    open[0]!.resolve(total);
    await flush();
  }
}

const callAt = (h: ReturnType<typeof rowHarness>, index: number): number | null => {
  const slot = slotAt(h.loader.displayed, index);
  return slot.kind === 'loaded' ? slot.item.call : null;
};

describe('PagedLoader', () => {
  it('requests the wanted pages, at most MAX_IN_FLIGHT at a time', async () => {
    const h = harness();
    h.loader.setWanted([0, 1, 2]);
    expect(h.calls.map((c) => c.offset)).toEqual([0, PAGE_SIZE]);
    h.calls[0]!.resolve(1000);
    await flush();
    expect(h.calls.map((c) => c.offset)).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE]);
    expect(h.maxInFlight).toBe(MAX_IN_FLIGHT);
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'loaded', item: 0 });
  });

  it('keeps the cap while requests of an older key are still outstanding', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    for (const key of ['B', 'C', 'D', 'E']) {
      h.loader.setKey(key);
      h.loader.setWanted([0]);
    }
    expect(h.calls).toHaveLength(MAX_IN_FLIGHT);
    expect(h.inFlight).toBe(MAX_IN_FLIGHT);
    // Neither outstanding request belongs to "E"; one settling frees a slot for it.
    h.calls[0]!.resolve(1000);
    await flush();
    expect(h.calls).toHaveLength(MAX_IN_FLIGHT + 1);
    h.calls[1]!.reject();
    h.calls[2]!.resolve(100);
    await flush();
    expect(h.maxInFlight).toBe(MAX_IN_FLIGHT);
    expect(h.loader.state.total).toBe(100);
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'loaded', item: 0 });
  });

  it('ignores a late accept of an earlier epoch of the same key (A → B → A)', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    h.loader.setKey('B');
    h.loader.setKey('A');
    h.loader.setWanted([0]);
    // The first "A" epoch and "B" fill both slots.
    expect(h.calls).toHaveLength(2);
    h.calls[0]!.resolve(5); // first "A" epoch: a stale answer
    await flush();
    expect(h.loader.state.total).toBeNull();
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'placeholder' });
    // The freed slot goes to the current "A" epoch.
    expect(h.calls).toHaveLength(3);
    h.calls[1]!.resolve(50); // "B": stale as well
    await flush();
    expect(h.loader.state.total).toBeNull();
    h.calls[2]!.resolve(500);
    await flush();
    expect(h.loader.state.total).toBe(500);
  });

  it('ignores a late reject of an earlier epoch of the same key (A → B → A)', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    h.loader.setKey('B');
    h.loader.setKey('A');
    h.loader.setWanted([0]);
    h.calls[0]!.reject();
    h.calls[1]!.reject();
    await flush();
    expect(h.loader.state.pages.get(0)).toEqual({ status: 'loading' });
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.resolve(500);
    await flush();
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'loaded', item: 0 });
  });

  it('keeps the cap when an accepted total drops loading pages beyond the end', async () => {
    const h = harness();
    h.loader.setWanted([0, 1, 2, 3]);
    expect(h.calls).toHaveLength(2);
    // Page 0 answers with a total that ends inside page 0: page 1 is dropped but still in flight.
    h.calls[0]!.resolve(10);
    await flush();
    h.loader.setWanted([0, 1, 2, 3]);
    expect(h.calls).toHaveLength(2);
    expect(h.inFlight).toBe(1);
  });

  it('dispatches nothing while inactive and resumes when active again', async () => {
    const h = harness();
    h.loader.setActive(false);
    h.loader.setWanted([0]);
    expect(h.calls).toHaveLength(0);
    h.loader.setActive(true);
    h.loader.setWanted([0]);
    expect(h.calls).toHaveLength(1);
    h.loader.setActive(false);
    const before = h.changes;
    h.calls[0]!.resolve(10);
    await flush();
    expect(h.changes).toBe(before);
  });

  it('retries a failed page', async () => {
    const h = harness();
    h.loader.setWanted([0]);
    h.calls[0]!.reject();
    await flush();
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'failed', page: 0 });
    h.loader.retry(0);
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve(10);
    await flush();
    expect(slotAt(h.loader.state, 9)).toEqual({ kind: 'loaded', item: 9 });
  });

  it('keeps the previous results displayed until page 0 of the new key settles', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    h.calls[0]!.resolve(100);
    await flush();
    h.loader.setKey('B');
    h.loader.setWanted([1]);
    expect(h.loader.displayed.key).toContain('A');
    expect(h.loader.displayed.total).toBe(100);
    expect(h.loader.pending).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.at(-1)!.offset).toBe(0); // page 0 first
    h.calls.at(-1)!.resolve(500);
    await flush();
    expect(h.loader.displayed.key).toContain('B');
    expect(h.loader.displayed).toBe(h.loader.state);
    expect(h.loader.pending).toBe(false);
    // Now the wanted page follows.
    expect(h.calls.at(-1)!.offset).toBe(PAGE_SIZE);
  });

  it('a late page of a superseded key is never displayed', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    h.calls[0]!.resolve(100);
    await flush();
    h.loader.setKey('B');
    const b = h.calls.at(-1)!;
    h.loader.setKey('C');
    const c = h.calls.at(-1)!;
    expect(c).not.toBe(b);
    c.resolve(3);
    b.resolve(50);
    await flush();
    expect(h.loader.displayed.key).toContain('C');
    expect(h.loader.displayed.total).toBe(3);
  });

  it('a failed first page of the new key takes over so its Retry shows', async () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    h.calls[0]!.resolve(100);
    await flush();
    h.loader.setKey('B');
    h.loader.setWanted([0]);
    h.calls.at(-1)!.reject();
    await flush();
    expect(h.loader.pending).toBe(false);
    expect(h.loader.displayed.key).toContain('B');
    expect(slotAt(h.loader.displayed, 0)).toEqual({ kind: 'failed', page: 0 });
    h.loader.retry(0);
    h.calls.at(-1)!.resolve(5);
    await flush();
    expect(slotAt(h.loader.displayed, 4)).toEqual({ kind: 'loaded', item: 4 });
  });

  it('shows the state of the first key at once', () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    expect(h.loader.pending).toBe(false);
    expect(h.loader.displayed.pages.get(0)).toEqual({ status: 'loading' });
  });

  it('applies an answer that settles while inactive, so reactivation does not wait for it', async () => {
    const h = harness();
    h.loader.setWanted([0]);
    h.loader.setActive(false);
    h.calls[0]!.resolve(10);
    await flush();
    h.loader.setActive(true);
    h.loader.setWanted([0]);
    expect(h.calls).toHaveLength(1);
    expect(slotAt(h.loader.displayed, 9)).toEqual({ kind: 'loaded', item: 9 });
  });

  it('loadThrough requests the missing pages up to the count within maxInFlight', async () => {
    const h = autoHarness(300);
    h.loader.setWanted([0]);
    await h.loader.loadThrough(200);
    // ceil(200 / 60) = 4 pages; page 4 is not needed.
    expect([...h.offsets].sort((a, b) => a - b)).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE, 3 * PAGE_SIZE]);
    expect(h.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(slotAt(h.loader.displayed, 199)).toEqual({ kind: 'loaded', item: 199 });
  });

  it('loadThrough stops at the total', async () => {
    const h = autoHarness(70);
    await h.loader.loadThrough(1000);
    expect([...h.offsets].sort((a, b) => a - b)).toEqual([0, PAGE_SIZE]);
    await h.loader.loadThrough(1000); // everything is loaded: nothing more to request
    expect(h.offsets).toHaveLength(2);
  });

  it('loadThrough resolves once failed pages have settled', async () => {
    const h = harness();
    const done = h.loader.loadThrough(100);
    h.calls[0]!.resolve(100);
    await flush();
    h.calls[1]!.reject();
    await expect(done).resolves.toBeUndefined();
    expect(slotAt(h.loader.state, 60)).toEqual({ kind: 'failed', page: 1 });
  });

  it('loadThrough rejects when the key changes meanwhile', async () => {
    const h = harness('A');
    const done = h.loader.loadThrough(100);
    h.loader.setKey('B');
    await expect(done).rejects.toThrow();
  });

  it('does not reset when the same key is set again', () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    const state = h.loader.state;
    expect(h.loader.setKey('A')).toBe(false);
    expect(h.loader.state).toBe(state);
  });

  it('answers its current key without the epoch', () => {
    const h = harness('A');
    expect(h.loader.key).toBe('A');
    h.loader.setKey('B');
    expect(h.loader.key).toBe('B');
  });
});

describe('PagedLoader.patch', () => {
  it('replaces one item, keeps the other pages identical and notifies once', async () => {
    const h = rowHarness();
    await loadPages(h, [0, 1], 200);
    const page1 = h.loader.state.pages.get(1);
    const requests = h.calls.length;
    const before = h.changes;
    h.loader.patch([{ id: 'r3', call: 99 }]);
    expect(callAt(h, 3)).toBe(99);
    expect(callAt(h, 4)).toBe(0);
    expect(h.loader.state.pages.get(1)).toBe(page1);
    expect(h.loader.displayed).toBe(h.loader.state);
    expect(h.changes).toBe(before + 1);
    expect(h.calls).toHaveLength(requests);
  });

  it('does nothing for an unknown id', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    const state = h.loader.state;
    const before = h.changes;
    h.loader.patch([{ id: 'nope', call: 99 }]);
    expect(h.loader.state).toBe(state);
    expect(h.changes).toBe(before);
  });
});

describe('PagedLoader.refresh', () => {
  it('refetches the wanted page in place and drops the other pages', async () => {
    const h = rowHarness();
    await loadPages(h, [0, 1], 200);
    h.loader.setWanted([1]);
    const requests = h.calls.length;
    const key = h.loader.displayed.key;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
    expect(h.calls.at(-1)!.offset).toBe(PAGE_SIZE);
    expect(h.loader.displayed.key).toBe(key);
    expect(h.loader.pending).toBe(false);
    expect(h.loader.state.pages.has(0)).toBe(false);
    // The old page stays until its answer arrives.
    expect(callAt(h, PAGE_SIZE)).toBe(1);
    h.calls.at(-1)!.resolve(200);
    await flush();
    expect(callAt(h, PAGE_SIZE)).toBe(requests);
    expect(h.loader.displayed.key).toBe(key);
    expect(h.loader.state.total).toBe(200);
    expect(h.calls).toHaveLength(requests + 1);
  });

  it('refetches page 0 when no page is wanted', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    h.loader.setWanted([]);
    h.loader.refresh();
    expect(h.calls.at(-1)!.offset).toBe(0);
    expect(h.open).toHaveLength(1);
  });

  it('drops pages beyond a shrunk total', async () => {
    const h = rowHarness();
    await loadPages(h, [0, 1], 200);
    h.loader.refresh();
    expect(h.open.map((c) => c.offset)).toEqual([0, PAGE_SIZE]);
    h.open[0]!.resolve(30);
    await flush();
    expect(h.loader.state.total).toBe(30);
    expect([...h.loader.state.pages.keys()]).toEqual([0]);
    h.open[0]!.resolve(30);
    await flush();
    expect([...h.loader.state.pages.keys()]).toEqual([0]);
    expect(slotAt(h.loader.displayed, 29)).toEqual({ kind: 'loaded', item: { id: 'r29', call: 2 } });
    expect(slotAt(h.loader.displayed, 30)).toEqual({ kind: 'placeholder' });
  });

  it('does not let a request started before the refresh overwrite the refreshed page', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    h.loader.setWanted([0, 1]);
    const early = h.calls.at(-1)!;
    expect(early.offset).toBe(PAGE_SIZE);
    h.loader.refresh();
    // Page 0 is refetched; page 1 waits for the slot the early request holds.
    expect(h.open.map((c) => c.offset)).toEqual([PAGE_SIZE, 0]);
    early.resolve(200);
    await flush();
    expect(slotAt(h.loader.state, PAGE_SIZE)).toEqual({ kind: 'placeholder' });
    const again = h.calls.at(-1)!;
    expect(again).not.toBe(early);
    expect(again.offset).toBe(PAGE_SIZE);
    again.resolve(200);
    await flush();
    expect(callAt(h, PAGE_SIZE)).toBe(h.calls.indexOf(again));
  });

  it('runs a refresh asked during a round exactly once after it', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    const requests = h.calls.length;
    h.loader.refresh();
    h.loader.refresh();
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
    h.open[0]!.resolve(200);
    await flush();
    expect(h.calls).toHaveLength(requests + 2);
    h.open[0]!.resolve(200);
    await flush();
    expect(h.calls).toHaveLength(requests + 2);
    expect(callAt(h, 0)).toBe(requests + 1);
  });

  it('refetches page 0 of an empty list and shows the new rows', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 0);
    expect(h.loader.state.total).toBe(0);
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
    expect(h.calls.at(-1)!.offset).toBe(0);
    h.open[0]!.resolve(2);
    await flush();
    expect(h.loader.displayed.total).toBe(2);
    expect(callAt(h, 1)).toBe(requests);
    // The round is over: the next refresh runs at once.
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 2);
  });

  it('ends the round of an empty list that stays empty', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 0);
    h.loader.refresh();
    h.open[0]!.resolve(0);
    await flush();
    expect(h.loader.state.total).toBe(0);
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
  });

  it('runs a refresh asked before page 0 settled once after it', async () => {
    const h = rowHarness('A');
    h.loader.setWanted([0]);
    h.loader.refresh();
    h.loader.refresh();
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.resolve(200);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.offset).toBe(0);
    h.calls[1]!.resolve(200);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(callAt(h, 0)).toBe(1);
  });

  it('runs a refresh asked while a key change is pending once after its page 0', async () => {
    const h = rowHarness('A');
    await loadPages(h, [0], 200);
    h.loader.setKey('B');
    expect(h.loader.pending).toBe(true);
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests);
    h.open[0]!.resolve(5);
    await flush();
    expect(h.loader.pending).toBe(false);
    expect(h.calls).toHaveLength(requests + 1);
    expect(h.calls.at(-1)!.offset).toBe(0);
    h.open[0]!.resolve(5);
    await flush();
    expect(h.calls).toHaveLength(requests + 1);
    expect(callAt(h, 0)).toBe(requests);
  });

  it('drops a queued refresh when the key changes again, since the new key loads fresh', async () => {
    const h = rowHarness('A');
    await loadPages(h, [0], 200);
    h.loader.setKey('B');
    h.loader.refresh();
    h.loader.setKey('C');
    const requests = h.calls.length;
    for (let open = h.open; open.length > 0; open = h.open) {
      open[0]!.resolve(5);
      await flush();
    }
    expect(h.loader.displayed.key).toContain('C');
    expect(h.calls).toHaveLength(requests);
  });

  it('runs a refresh asked while inactive when it turns active again', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    h.loader.setActive(false);
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests);
    h.loader.setActive(true);
    expect(h.calls).toHaveLength(requests + 1);
    expect(h.calls.at(-1)!.offset).toBe(0);
  });

  it('drops the answers of a round when the key changes', async () => {
    const h = rowHarness('A');
    await loadPages(h, [0], 200);
    const shown = h.loader.displayed;
    h.loader.refresh();
    const round = h.calls.at(-1)!;
    h.loader.setKey('B');
    const b = h.calls.at(-1)!;
    expect(b).not.toBe(round);
    round.resolve(7);
    await flush();
    expect(h.loader.state.total).toBeNull();
    expect(h.loader.displayed).toBe(shown);
    b.resolve(3);
    await flush();
    expect(h.loader.displayed.key).toContain('B');
    expect(h.loader.displayed.total).toBe(3);
    // The round of "A" is over: a refresh of "B" runs at once.
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
  });

  it('keeps the old items when a refetch fails', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    const page0 = h.loader.state.pages.get(0);
    h.loader.refresh();
    h.open[0]!.reject();
    await flush();
    expect(h.loader.state.pages.get(0)).toBe(page0);
    expect(h.loader.state.total).toBe(200);
    // The round has settled, so the next refresh runs.
    const requests = h.calls.length;
    h.loader.refresh();
    expect(h.calls).toHaveLength(requests + 1);
  });

  it('refetches a failed wanted page too', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    h.loader.setWanted([0, 1]);
    h.calls.at(-1)!.reject();
    await flush();
    expect(slotAt(h.loader.state, PAGE_SIZE)).toEqual({ kind: 'failed', page: 1 });
    h.loader.refresh();
    expect(h.open.map((c) => c.offset)).toEqual([0, PAGE_SIZE]);
    expect(slotAt(h.loader.displayed, PAGE_SIZE)).toEqual({ kind: 'failed', page: 1 });
    h.open[1]!.resolve(200);
    await flush();
    expect(slotAt(h.loader.displayed, PAGE_SIZE).kind).toBe('loaded');
  });

  it('never has more than maxInFlight requests unsettled', async () => {
    const h = rowHarness();
    await loadPages(h, [0, 1, 2, 3], 1000);
    h.loader.setWanted([0, 1, 2, 3, 4]);
    h.loader.refresh();
    h.loader.setWanted([2, 3, 4, 5]);
    expect(h.inFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    for (let i = 0; i < 20 && h.open.length > 0; i += 1) {
      h.open[0]!.resolve(1000);
      await flush();
      expect(h.inFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    }
    expect(h.open).toHaveLength(0);
    expect(h.maxInFlight).toBe(MAX_IN_FLIGHT);
    for (const p of [2, 3, 4, 5]) expect(slotAt(h.loader.displayed, p * PAGE_SIZE).kind).toBe('loaded');
  });

  it('requests pages that become wanted during a round in that round', async () => {
    const h = rowHarness();
    await loadPages(h, [0], 200);
    h.loader.refresh();
    h.loader.setWanted([0, 1]);
    expect(h.open.map((c) => c.offset)).toEqual([0, PAGE_SIZE]);
    h.open[1]!.resolve(200);
    await flush();
    expect(slotAt(h.loader.displayed, PAGE_SIZE).kind).toBe('loaded');
  });
});
