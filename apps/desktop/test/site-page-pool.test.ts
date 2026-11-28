import { describe, expect, it } from 'vitest';
import type { PageLoadResult } from '@assetforge/core';
import { createPagePool } from '../src/main/site-page-pool.js';

function factory() {
  const calls: { id: number; url: string }[] = [];
  const closed: number[] = [];
  const release = new Map<number, () => void>();
  let created = 0;
  const create = (gone: () => void) => {
    const id = ++created;
    return {
      loader: {
        load: (url: string, options: { signal: AbortSignal }) =>
          new Promise<PageLoadResult>((resolve) => {
            calls.push({ id, url });
            const finish = (result: PageLoadResult) => {
              options.signal.removeEventListener('abort', abort);
              release.delete(id);
              resolve(result);
            };
            const abort = () => finish({ ok: false, reason: 'failed' });
            release.set(id, () => finish({ ok: true, results: {}, baseUrl: url, finalUrl: url }));
            options.signal.addEventListener('abort', abort, { once: true });
          }),
      },
      close() {
        closed.push(id);
        gone();
      },
    };
  };
  return { create, calls, closed, release, created: () => created };
}

const request = (signal = new AbortController().signal) => ({ queries: {}, waitFor: 'file', signal });
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('crawl page pool', () => {
  it('bounds open windows and reuses a freed page for the next queued URL', async () => {
    const f = factory();
    const pool = createPagePool(f.create, 2);
    const first = pool.loader.load('https://gallery.test/1', request());
    const second = pool.loader.load('https://gallery.test/2', request());
    const third = pool.loader.load('https://gallery.test/3', request());
    expect(f.created()).toBe(2);
    expect(f.calls).toHaveLength(2);
    f.release.get(1)!();
    await first;
    await tick();
    expect(f.calls[2]).toEqual({ id: 1, url: 'https://gallery.test/3' });
    expect(f.created()).toBe(2);
    pool.close();
    await Promise.all([second, third]);
  });

  it('cancels a queued load without navigating it or leaking its queue slot', async () => {
    const f = factory();
    const pool = createPagePool(f.create, 1);
    const running = pool.loader.load('https://gallery.test/1', request());
    const controller = new AbortController();
    const cancelled = pool.loader.load('https://gallery.test/cancelled', request(controller.signal));
    const next = pool.loader.load('https://gallery.test/next', request());
    controller.abort();
    expect(await cancelled).toEqual({ ok: false, reason: 'failed' });
    f.release.get(1)!();
    await running;
    await tick();
    expect(f.calls.map((call) => call.url)).toEqual(['https://gallery.test/1', 'https://gallery.test/next']);
    pool.close();
    await next;
  });

  it('aborts running loads, releases queued callers and reports pool closure once', async () => {
    const f = factory();
    let gone = 0;
    const pool = createPagePool(f.create, 2, () => gone++);
    const pending = ['/1', '/2', '/3'].map((path) => pool.loader.load(`https://gallery.test${path}`, request()));
    pool.close();
    pool.close();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 3 }, () => ({ ok: false, reason: 'failed' })));
    expect(f.closed).toEqual([1, 2]);
    expect(gone).toBe(1);
    expect(await pool.loader.load('https://gallery.test/after', request())).toEqual({ ok: false, reason: 'failed' });
    expect(f.calls).toHaveLength(2);
  });
});
