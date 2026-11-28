import { Worker } from 'node:worker_threads';
import type {
  ImageSize,
  PreviewJob,
  PreviewResult,
  WorkerJob,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './messages.js';

/** What `createWorkerPool` is configured with. */
export interface WorkerPoolOptions {
  /** The worker entry (`preview-worker`). */
  workerUrl: URL;
  /** Maximum number of worker threads; a positive integer. */
  size: number;
  /** How long one job may take before its worker is terminated. */
  timeoutMs: number;
  /** Receives one line per worker failure, never a path or an error message. Default: console.error. */
  log?: (line: string) => void;
  /**
   * The clock of the start back-off; default `Date.now`.
   *
   * @returns the current time in milliseconds
   */
  now?: () => number;
}

/** Sharp work in bounded worker threads. */
export interface WorkerPool {
  /**
   * Renders one preview. Never rejects.
   *
   * @param job what to render where
   * @returns `ok`, or `none` for a crash, a timeout, a closed pool or a source without a preview
   */
  run(job: PreviewJob): Promise<PreviewResult>;
  /**
   * Image dimensions after EXIF orientation. Never rejects.
   *
   * @param sourcePath the image
   * @returns the dimensions; `null` for a crash, a timeout, a closed pool or an unreadable image
   */
  measure(sourcePath: string): Promise<ImageSize | null>;
  /**
   * A JPEG of the image for a vision model. Never rejects.
   *
   * @param sourcePath the image
   * @returns the JPEG bytes; `null` for a crash, a timeout, a closed pool, an invalid answer or an unreadable image
   */
  jpeg(sourcePath: string): Promise<Uint8Array | null>;
  /**
   * Moves a render that is still waiting for a worker to the newest place of the queue, so a tile asked for again is
   * served next; a render already running or not queued is left alone.
   *
   * @param targetPath the target path of the waiting render
   */
  prioritize(targetPath: string): void;
  /**
   * Terminates all workers; queued and running jobs resolve their failure value (`none` for a render, `null` for a
   * measurement or a JPEG).
   *
   * @returns resolves once every worker has terminated
   */
  close(): Promise<void>;
}

/** Worker threads of the app's pool. */
export const POOL_SIZE = 2;
/** Time limit of one job in the app's pool. */
export const JOB_TIMEOUT_MS = 30_000;
/** The wait after a worker failed to start before the next start; it doubles with every further failed start. */
export const WORKER_START_BACKOFF_MS = 2_000;
/** The longest wait between two worker starts after failed ones. */
export const WORKER_START_BACKOFF_MAX_MS = 60_000;

/** What a task resolves to: the answer of its kind or its failure value. */
type TaskResult = PreviewResult | ImageSize | Uint8Array | null;

/** One job waiting for or running in a worker. */
interface Task {
  /** The work sent to the worker. */
  work: WorkerJob;
  /** What the task resolves when it fails: `none` for a render, `null` for a measurement or a JPEG. */
  failure: 'none' | null;
  /** Ends the task's promise. */
  resolve: (result: TaskResult) => void;
}

/** One worker thread and the job it runs. */
interface Slot {
  /** The worker. */
  worker: Worker;
  /** The worker reported that its module loaded; before that it gets no work. */
  ready: boolean;
  /** Ends a start that takes longer than the job time limit; cleared once the worker is ready. */
  startTimer?: NodeJS.Timeout;
  /** The task the worker was started for, sent to it once it is ready. */
  reserved?: Task;
  /** The running job with its request id and timeout. */
  current?: { id: number; task: Task; timer: NodeJS.Timeout };
}

/**
 * Error code or class name of a worker failure; messages are left out because they may hold paths.
 *
 * @param error what the worker or its start threw
 * @returns an upper-case code, a class name, or `unknown`
 */
function failureKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]+$/.test(name) ? name : 'unknown';
}

/**
 * Whether a message from a worker has the shape of a response.
 *
 * @param message the message as received
 * @returns true for an object with a numeric `id`
 */
function isResponse(message: unknown): message is WorkerResponse {
  return typeof message === 'object' && message !== null && typeof (message as WorkerResponse).id === 'number';
}

/**
 * Whether a message from a worker says that its module loaded.
 *
 * @param message the message as received
 * @returns true for `{ ready: true }`
 */
function isReady(message: unknown): message is WorkerReady {
  return typeof message === 'object' && message !== null && (message as WorkerReady).ready === true;
}

/**
 * The wait before the next worker start after a run of failed ones.
 *
 * @param failedStarts the failed starts in a row, at least 1
 * @returns the back-off, doubled per further failure and capped
 */
function startBackOffMs(failedStarts: number): number {
  return Math.min(WORKER_START_BACKOFF_MS * 2 ** Math.min(failedStarts - 1, 30), WORKER_START_BACKOFF_MAX_MS);
}

/**
 * Whether a value is an image size with whole-number edges.
 *
 * @param value the worker's answer
 * @returns true for `{ width, height }` with integers
 */
function isSize(value: unknown): value is ImageSize {
  const size = value as Partial<ImageSize> | null;
  return typeof size === 'object' && size !== null && Number.isInteger(size.width) && Number.isInteger(size.height);
}

/**
 * The result a task accepts from a worker; anything else counts as a failure.
 *
 * @param task the task the answer belongs to
 * @param result the worker's answer
 * @returns the answer, copied for a size, or the task's failure value
 */
function validResult(task: Task, result: unknown): TaskResult {
  if (task.work.kind === 'render') return result === 'ok' ? 'ok' : 'none';
  if (task.work.kind === 'jpeg') return result instanceof Uint8Array && result.byteLength > 0 ? result : null;
  return isSize(result) ? { width: result.width, height: result.height } : null;
}

/**
 * Runs preview jobs in at most `size` worker threads, one job per worker at a time. Workers
 * start lazily; further jobs wait and are served newest first, so the tiles requested last (the
 * ones in view after a fast scroll) are generated before those scrolled past. A worker that
 * fails, crashes or exceeds `timeoutMs` fails its job (`none` or `null`) and is dropped, so the next job
 * gets a fresh worker; a worker error or a failed start is logged as one line, and the same line again only after a
 * worker answered in between. A worker gets work only once it reported that its module loaded; one that fails
 * before (or not within `timeoutMs`) fails the whole queue, and the next start waits out a back-off
 * (`WORKER_START_BACKOFF_MS`, doubled per further failed start up to `WORKER_START_BACKOFF_MAX_MS`) during which
 * every request fails at once.
 *
 * @param options the worker entry, the size, the time limit and the log
 * @returns the pool, with no worker started yet
 * @throws RangeError when `size` is not a positive integer
 */
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  if (!Number.isInteger(options.size) || options.size < 1) {
    throw new RangeError('The worker pool size must be a positive integer');
  }
  const pool = new PreviewWorkers(options, options.log ?? ((line: string) => console.error(line)));
  return {
    run: (job) => pool.submit({ kind: 'render', job }, 'none') as Promise<PreviewResult>,
    measure: (sourcePath) => pool.submit({ kind: 'measure', sourcePath }, null) as Promise<ImageSize | null>,
    jpeg: (sourcePath) => pool.submit({ kind: 'jpeg', sourcePath }, null) as Promise<Uint8Array | null>,
    prioritize: (targetPath) => pool.prioritize(targetPath),
    close: () => pool.close(),
  };
}

/** The workers, the waiting tasks and the terminations of one pool. */
class PreviewWorkers {
  /** The live workers. */
  private readonly slots = new Set<Slot>();
  /** Tasks waiting for a worker; the newest is served first. */
  private readonly queue: Task[] = [];
  /** Terminations in progress, which `close` waits for. */
  private readonly terminations = new Set<Promise<unknown>>();
  /** The id of the next request. */
  private nextId = 1;
  /** `close` was called. */
  private isClosed = false;
  /** The failure line logged last since a worker last answered; null when none was. */
  private lastReported: string | null = null;
  /** Worker starts that failed in a row; reset once a worker is ready. */
  private failedStarts = 0;
  /** No worker is started before this time, in milliseconds. */
  private startAllowedAt = 0;
  /** The clock of the back-off. */
  private readonly now: () => number;

  /**
   * @param options the worker entry, the size, the time limit and the clock
   * @param log receives one line per worker failure
   */
  constructor(
    private readonly options: WorkerPoolOptions,
    private readonly log: (line: string) => void,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Queues one task and serves the queue.
   *
   * @param work the work for the worker
   * @param failure what the task resolves when it fails
   * @returns the worker's valid answer or the failure value
   */
  submit(work: WorkerJob, failure: 'none' | null): Promise<TaskResult> {
    if (this.isClosed || this.isBackingOff()) return Promise.resolve(failure);
    return new Promise<TaskResult>((resolve) => {
      this.queue.push({ work, failure, resolve });
      this.pump();
    });
  }

  /**
   * See `WorkerPool.prioritize`.
   *
   * @param targetPath the target path of the waiting render
   */
  prioritize(targetPath: string): void {
    const index = this.queue.findIndex(
      (task) => task.work.kind === 'render' && task.work.job.targetPath === targetPath,
    );
    if (index < 0) return;
    const [task] = this.queue.splice(index, 1);
    this.queue.push(task!);
  }

  /**
   * See `WorkerPool.close`.
   *
   * @returns resolves once every worker has terminated
   */
  async close(): Promise<void> {
    this.isClosed = true;
    for (const task of this.queue.splice(0)) task.resolve(task.failure);
    for (const slot of [...this.slots]) this.dropAndTerminate(slot);
    await Promise.all([...this.terminations]);
  }

  /**
   * Hands waiting tasks to idle ready workers and starts workers up to the size; a worker started takes the newest
   * task with it and runs it once ready.
   */
  private pump(): void {
    while (!this.isClosed && this.queue.length > 0) {
      const slot = [...this.slots].find((candidate) => candidate.ready && !candidate.current);
      if (slot) {
        this.dispatch(slot, this.queue.pop() as Task);
        continue;
      }
      if (this.slots.size >= this.options.size || this.isBackingOff()) return;
      this.startWorker(this.queue.pop() as Task);
    }
  }

  /**
   * Whether worker starts wait out a back-off after failed ones.
   *
   * @returns true until the back-off has passed
   */
  private isBackingOff(): boolean {
    return this.failedStarts > 0 && this.now() < this.startAllowedAt;
  }

  /**
   * Starts one worker and listens to it; a start that throws counts as a failed start.
   *
   * @param task the task the worker is started for
   */
  private startWorker(task: Task): void {
    let worker: Worker;
    try {
      worker = new Worker(this.options.workerUrl);
    } catch (error) {
      task.resolve(task.failure);
      this.startFailed(failureKind(error));
      return;
    }
    const slot: Slot = { worker, ready: false, reserved: task };
    slot.startTimer = setTimeout(() => this.dropStarting(slot, 'timeout'), this.options.timeoutMs);
    worker.on('message', (message: unknown) => this.answer(slot, message));
    worker.on('error', (error: unknown) => this.workerFailed(slot, error));
    worker.on('exit', () => (slot.ready ? this.dropExited(slot) : this.dropStarting(slot, 'exit')));
    this.slots.add(slot);
  }

  /**
   * Handles an error of a worker: before it was ready a failed start, afterwards the failure of its job.
   *
   * @param slot the worker's slot
   * @param error what the worker threw
   */
  private workerFailed(slot: Slot, error: unknown): void {
    if (!slot.ready) {
      this.dropStarting(slot, failureKind(error));
      return;
    }
    // Only the first failure of a slot is logged.
    if (this.slots.has(slot)) this.report(`Preview worker failed (${failureKind(error)})`);
    this.dropAndTerminate(slot);
  }

  /**
   * Drops a worker that failed before it was ready and treats it as a failed start.
   *
   * @param slot the worker's slot
   * @param kind the failure kind for the log line
   */
  private dropStarting(slot: Slot, kind: string): void {
    if (!this.removeSlot(slot)) return;
    this.terminate(slot.worker);
    this.startFailed(kind);
  }

  /**
   * A worker could not start: logs the line, fails every waiting task at once and begins or extends the back-off.
   * A start that fails while a back-off runs (a second worker started with the first) does not extend it.
   *
   * @param kind the failure kind for the log line
   */
  private startFailed(kind: string): void {
    this.report(`Preview worker failed to start (${kind})`);
    if (!this.isBackingOff()) {
      this.failedStarts++;
      this.startAllowedAt = this.now() + startBackOffMs(this.failedStarts);
    }
    for (const task of this.queue.splice(0)) task.resolve(task.failure);
  }

  /**
   * Marks a worker ready, ends the back-off and serves the queue.
   *
   * @param slot the worker's slot
   */
  private markReady(slot: Slot): void {
    if (slot.ready || !this.slots.has(slot)) return;
    clearTimeout(slot.startTimer);
    slot.ready = true;
    this.failedStarts = 0;
    this.startAllowedAt = 0;
    const task = slot.reserved;
    slot.reserved = undefined;
    if (task) this.dispatch(slot, task);
    else this.pump();
  }

  /**
   * Logs a worker failure unless the same line was logged since a worker last answered, so a module that cannot load
   * gives one line rather than one per queued job.
   *
   * @param line the failure line, without a path
   */
  private report(line: string): void {
    if (line === this.lastReported) return;
    this.lastReported = line;
    this.log(line);
  }

  /**
   * Ends the running task of a slot with a worker's answer; answers to anything else are ignored.
   *
   * @param slot the worker's slot
   * @param message the message as received
   */
  private answer(slot: Slot, message: unknown): void {
    if (isReady(message)) {
      this.markReady(slot);
      return;
    }
    if (!isResponse(message) || !this.slots.has(slot) || slot.current?.id !== message.id) return;
    // A worker answered, so the module loads again: the next failure is news and is logged.
    this.lastReported = null;
    this.finish(slot, validResult(slot.current.task, message.result));
    this.pump();
  }

  /**
   * Sends a task to an idle worker and starts its timeout.
   *
   * @param slot the idle worker's slot
   * @param task the task
   */
  private dispatch(slot: Slot, task: Task): void {
    const id = this.nextId++;
    const timer = setTimeout(() => this.dropAndTerminate(slot), this.options.timeoutMs);
    slot.current = { id, task, timer };
    const request: WorkerRequest = { id, work: task.work };
    try {
      slot.worker.postMessage(request);
    } catch {
      this.dropAndTerminate(slot);
    }
  }

  /**
   * Ends the running task of a slot, if any.
   *
   * @param slot the slot
   * @param result the task's result; undefined fails it with its failure value
   */
  private finish(slot: Slot, result: TaskResult | undefined): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    slot.current = undefined;
    current.task.resolve(result === undefined ? current.task.failure : result);
  }

  /**
   * Drops a worker that exited on its own: its running task fails and the queue is served again.
   *
   * @param slot the worker's slot
   */
  private dropExited(slot: Slot): void {
    if (!this.removeSlot(slot)) return;
    this.pump();
  }

  /**
   * Drops a worker that failed, timed out or is closed: its running task fails, the worker is terminated and the
   * queue is served again.
   *
   * @param slot the worker's slot
   */
  private dropAndTerminate(slot: Slot): void {
    if (!this.removeSlot(slot)) return;
    this.terminate(slot.worker);
    this.pump();
  }

  /**
   * Removes a slot and fails its running task.
   *
   * @param slot the slot
   * @returns false when the slot was already gone
   */
  private removeSlot(slot: Slot): boolean {
    if (!this.slots.delete(slot)) return false;
    clearTimeout(slot.startTimer);
    const reserved = slot.reserved;
    slot.reserved = undefined;
    reserved?.resolve(reserved.failure);
    this.finish(slot, undefined);
    return true;
  }

  /**
   * Terminates a worker so that `close` waits for it.
   *
   * @param worker the worker
   */
  private terminate(worker: Worker): void {
    const done = worker.terminate().catch(() => undefined);
    this.terminations.add(done);
    void done.finally(() => this.terminations.delete(done));
  }
}
