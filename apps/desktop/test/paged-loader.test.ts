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
    expect(h.calls).toHaveLength(2);
    h.calls[0]!.resolve(5); // first "A" epoch: a stale answer
    await flush();
    expect(h.loader.state.total).toBeNull();
    expect(slotAt(h.loader.state, 0)).toEqual({ kind: 'placeholder' });
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve(500);
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
    await flush();
    expect(h.loader.state.pages.get(0)).toEqual({ status: 'loading' });
    h.calls[1]!.resolve(500);
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

  it('does not reset when the same key is set again', () => {
    const h = harness('A');
    h.loader.setWanted([0]);
    const state = h.loader.state;
    expect(h.loader.setKey('A')).toBe(false);
    expect(h.loader.state).toBe(state);
  });
});
