import { describe, expect, it } from 'vitest';
import { latestOnly } from '../src/renderer/src/hooks/useLoad.js';

describe('latestOnly', () => {
  it('marks an earlier promise stale when a later one was registered', async () => {
    const track = latestOnly<string>();
    let resolveFirst!: (v: string) => void;
    const first = track(new Promise<string>((r) => (resolveFirst = r)));
    const second = track(Promise.resolve('second'));
    resolveFirst('first');
    expect(await first).toEqual({ stale: true });
    expect(await second).toEqual({ stale: false, value: 'second' });
  });

  it('passes value and error through for the latest promise', async () => {
    const track = latestOnly<number>();
    expect(await track(Promise.resolve(1))).toEqual({ stale: false, value: 1 });
    const failure = new Error('boom');
    expect(await track(Promise.reject(failure))).toEqual({ stale: false, error: failure });
  });

  it('marks a stale rejection stale as well', async () => {
    const track = latestOnly<number>();
    const first = track(Promise.reject(new Error('old')));
    await track(Promise.resolve(2));
    expect(await first).toEqual({ stale: true });
  });
});
