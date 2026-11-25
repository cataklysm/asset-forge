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
});
