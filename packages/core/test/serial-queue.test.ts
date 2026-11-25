import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-scheduled promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SerialQueue', () => {
  it('runs operations one at a time in call order', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, i) =>
      queue.run(async () => {
        events.push(`start ${i}`);
        await gate.promise;
        events.push(`end ${i}`);
      }),
    );

    await flush();
    expect(events).toEqual(['start 0']);
    gates[2]!.resolve();
    gates[1]!.resolve();
    await flush();
    expect(events).toEqual(['start 0']);
    gates[0]!.resolve();
    await Promise.all(runs);
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('a rejected operation does not block the next one', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const throwingSync = queue.run(() => {
      throw new Error('sync boom');
    });
    const next = queue.run(async () => 'ran');

    await expect(failing).rejects.toThrow('boom');
    await expect(throwingSync).rejects.toThrow('sync boom');
    await expect(next).resolves.toBe('ran');
  });

  it("returns each operation's own result", async () => {
    const queue = new SerialQueue();
    const slow = deferred<number>();
    const first = queue.run(() => slow.promise);
    const second = queue.run(async () => 'two');
    slow.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe('two');
  });
});
