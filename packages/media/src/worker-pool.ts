import { Worker } from 'node:worker_threads';
import type { ImageSize, PreviewJob, PreviewResult, WorkerJob, WorkerRequest, WorkerResponse } from './messages.js';

export interface WorkerPoolOptions {
  workerUrl: URL;
  /** Maximum number of worker threads; a positive integer. */
  size: number;
  timeoutMs: number;
  /** Receives one line per worker failure, never a path or an error message. Default: console.error. */
  log?: (line: string) => void;
}

export interface WorkerPool {
  /** Never rejects: a crash, a timeout or a closed pool resolve `none`. */
  run(job: PreviewJob): Promise<PreviewResult>;
  /** Image dimensions after EXIF orientation. Never rejects: a crash, a timeout, a closed pool or an unreadable image resolve `null`. */
  measure(sourcePath: string): Promise<ImageSize | null>;
  /** Terminates all workers; queued and running jobs resolve `none`. */
  close(): Promise<void>;
}

export const POOL_SIZE = 2;
export const JOB_TIMEOUT_MS = 30_000;

type TaskResult = PreviewResult | ImageSize | null;

interface Task {
  work: WorkerJob;
  /** What the task resolves when it fails: `none` for a render, `null` for a measurement. */
  failure: 'none' | null;
  resolve: (result: TaskResult) => void;
}

interface Slot {
  worker: Worker;
  current?: { id: number; task: Task; timer: NodeJS.Timeout };
}

/** Error code or class name of a worker failure; messages are left out because they may hold paths. */
function failureKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]+$/.test(name) ? name : 'unknown';
}

function isResponse(message: unknown): message is WorkerResponse {
  return typeof message === 'object' && message !== null && typeof (message as WorkerResponse).id === 'number';
}

function isSize(value: unknown): value is ImageSize {
  const size = value as Partial<ImageSize> | null;
  return typeof size === 'object' && size !== null && Number.isInteger(size.width) && Number.isInteger(size.height);
}

/** The result a task accepts from a worker; anything else counts as a failure. */
function validResult(task: Task, result: unknown): TaskResult {
  if (task.work.kind === 'render') return result === 'ok' ? 'ok' : 'none';
  return isSize(result) ? { width: result.width, height: result.height } : null;
}

/**
 * Runs preview jobs in at most `size` worker threads, one job per worker at a time. Workers
 * start lazily; further jobs wait and are served newest first, so the tiles requested last (the
 * ones in view after a fast scroll) are generated before those scrolled past. A worker that
 * fails, crashes or exceeds `timeoutMs` fails its job as `none` and is dropped, so the next job
 * gets a fresh worker; a worker error or a failed start is logged as one line.
 */
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  const { workerUrl, size, timeoutMs } = options;
  if (!Number.isInteger(size) || size < 1) throw new RangeError('The worker pool size must be a positive integer');
  const log = options.log ?? ((line: string) => console.error(line));
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

  function finish(slot: Slot, result: TaskResult | undefined): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    slot.current = undefined;
    current.task.resolve(result === undefined ? current.task.failure : result);
  }

  function drop(slot: Slot, kill: boolean): void {
    if (!slots.delete(slot)) return;
    finish(slot, undefined);
    if (kill) terminate(slot.worker);
    pump();
  }

  function spawn(): Slot | undefined {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl);
    } catch (error) {
      log(`Preview worker failed to start (${failureKind(error)})`);
      return undefined;
    }
    const slot: Slot = { worker };
    worker.on('message', (message: unknown) => {
      if (!isResponse(message) || !slots.has(slot) || slot.current?.id !== message.id) return;
      finish(slot, validResult(slot.current.task, message.result));
      pump();
    });
    worker.on('error', (error: unknown) => {
      // A failed start arrives here as well; only the first failure of a slot is logged.
      if (slots.has(slot)) log(`Preview worker failed (${failureKind(error)})`);
      drop(slot, true);
    });
    worker.on('exit', () => drop(slot, false));
    slots.add(slot);
    return slot;
  }

  function dispatch(slot: Slot, task: Task): void {
    const id = nextId++;
    const timer = setTimeout(() => drop(slot, true), timeoutMs);
    slot.current = { id, task, timer };
    const request: WorkerRequest = { id, work: task.work };
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
          const failed = queue.pop();
          failed?.resolve(failed.failure);
          continue;
        }
      }
      dispatch(slot, queue.pop() as Task);
    }
  }

  function submit(work: WorkerJob, failure: 'none' | null): Promise<TaskResult> {
    if (closed) return Promise.resolve(failure);
    return new Promise<TaskResult>((resolve) => {
      queue.push({ work, failure, resolve });
      pump();
    });
  }

  return {
    run(job) {
      return submit({ kind: 'render', job }, 'none') as Promise<PreviewResult>;
    },
    measure(sourcePath) {
      return submit({ kind: 'measure', sourcePath }, null) as Promise<ImageSize | null>;
    },
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.resolve(task.failure);
      for (const slot of [...slots]) drop(slot, true);
      await Promise.all([...terminations]);
    },
  };
}
