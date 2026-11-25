import { Worker } from 'node:worker_threads';
import type { PreviewJob, PreviewResult, WorkerRequest, WorkerResponse } from './messages.js';

export interface WorkerPoolOptions {
  workerUrl: URL;
  size: number;
  timeoutMs: number;
}

export interface WorkerPool {
  /** Never rejects: a crash, a timeout or a closed pool resolve `none`. */
  run(job: PreviewJob): Promise<PreviewResult>;
  /** Terminates all workers; queued and running jobs resolve `none`. */
  close(): Promise<void>;
}

export const POOL_SIZE = 2;
export const JOB_TIMEOUT_MS = 30_000;

interface Task {
  job: PreviewJob;
  resolve: (result: PreviewResult) => void;
}

interface Slot {
  worker: Worker;
  current?: { id: number; task: Task; timer: NodeJS.Timeout };
}

/**
 * Runs preview jobs in at most `size` worker threads, one job per worker at a time. Workers
 * start lazily; further jobs wait in FIFO order. A worker that crashes or exceeds `timeoutMs`
 * fails its job as `none` and is dropped, so the next job gets a fresh worker.
 */
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  const { workerUrl, size, timeoutMs } = options;
  const slots = new Set<Slot>();
  const queue: Task[] = [];
  const terminations = new Set<Promise<unknown>>();
  let nextId = 1;
  let closed = false;

  function terminate(worker: Worker): void {
    const done = worker.terminate().catch(() => undefined);
    terminations.add(done);
    void done.finally(() => terminations.delete(done));
  }

  function finish(slot: Slot, result: PreviewResult): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    slot.current = undefined;
    current.task.resolve(result);
  }

  function drop(slot: Slot, kill: boolean): void {
    if (!slots.delete(slot)) return;
    finish(slot, 'none');
    if (kill) terminate(slot.worker);
    pump();
  }

  function spawn(): Slot | undefined {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl);
    } catch {
      return undefined;
    }
    const slot: Slot = { worker };
    worker.on('message', (response: WorkerResponse) => {
      if (!slots.has(slot) || slot.current?.id !== response?.id) return;
      finish(slot, response.result === 'ok' ? 'ok' : 'none');
      pump();
    });
    worker.on('error', () => drop(slot, true));
    worker.on('exit', () => drop(slot, false));
    slots.add(slot);
    return slot;
  }

  function dispatch(slot: Slot, task: Task): void {
    const id = nextId++;
    const timer = setTimeout(() => drop(slot, true), timeoutMs);
    slot.current = { id, task, timer };
    const request: WorkerRequest = { id, job: task.job };
    try {
      slot.worker.postMessage(request);
    } catch {
      drop(slot, true);
    }
  }

  function pump(): void {
    while (!closed && queue.length > 0) {
      let slot = [...slots].find((candidate) => !candidate.current);
      if (!slot) {
        if (slots.size >= size) return;
        slot = spawn();
        if (!slot) {
          queue.shift()?.resolve('none');
          continue;
        }
      }
      dispatch(slot, queue.shift() as Task);
    }
  }

  return {
    run(job) {
      if (closed) return Promise.resolve('none');
      return new Promise<PreviewResult>((resolve) => {
        queue.push({ job, resolve });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.resolve('none');
      for (const slot of [...slots]) drop(slot, true);
      await Promise.all([...terminations]);
    },
  };
}
