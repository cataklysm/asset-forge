import { Worker } from 'node:worker_threads';
import type { SnapshotFacts } from '@assetforge/core';

/**
 * Checks a local copy of a workspace database and reads its facts. The copy is folded into one file (no side files
 * are left), so it may be renamed or streamed afterwards. A stopped or timed-out check answers null at once while its
 * worker may still hold the copy open; delete the copy only after `checkExited(path)`.
 *
 * @param path the absolute path of the copy
 * @param signal stops the check; it then answers null
 * @returns the facts; null when the copy is not a readable workspace database, its `quick_check` was not ok, the check
 *   timed out or was stopped
 */
export type BackupChecker = (path: string, signal?: AbortSignal) => Promise<SnapshotFacts | null>;

/** The time a check may take before it counts as failed. */
export const BACKUP_CHECK_TIMEOUT_MS = 120_000;

/** The options of `createBackupChecker`. */
export interface BackupCheckerOptions {
  /** The built worker entry (`backup-check-worker`). */
  workerUrl: URL;
  /** The migrations of this app, to tell the applied count and a newer schema. */
  migrationsFolder: string;
  /** The time a check may take; `BACKUP_CHECK_TIMEOUT_MS` by default. */
  timeoutMs?: number;
}

/** What the worker is started with. */
export interface BackupCheckRequest {
  /** The absolute path of the copy. */
  path: string;
  /** The migrations of this app. */
  migrationsFolder: string;
}

/** The exits of the workers still running, per checked path. */
const runningChecks = new Map<string, Set<Promise<void>>>();

/**
 * Resolves once every worker started for a path has exited. A worker busy in a synchronous SQLite call ends only when
 * that call returns, so a stopped check answers before its worker is gone; whoever deletes the copy waits for this
 * first, because Windows cannot delete a file with an open handle.
 *
 * @param path the absolute path of the copy
 * @returns resolves at once when no worker runs for it; never rejects
 */
export async function checkExited(path: string): Promise<void> {
  await Promise.all(runningChecks.get(path) ?? []);
}

/**
 * Whether a worker still runs for a path.
 *
 * @param path the absolute path of the copy
 * @returns true while one runs
 */
export function isCheckRunning(path: string): boolean {
  return runningChecks.has(path);
}

/**
 * Registers the exit of a worker for a path until it has happened.
 *
 * @param path the checked path
 * @param exited resolves on the worker's exit
 */
function trackExit(path: string, exited: Promise<void>): void {
  const exits = runningChecks.get(path) ?? new Set<Promise<void>>();
  exits.add(exited);
  runningChecks.set(path, exits);
  void exited.then(() => {
    exits.delete(exited);
    if (exits.size === 0 && runningChecks.get(path) === exits) runningChecks.delete(path);
  });
}

/**
 * A checker that runs every check in a worker thread of its own, so nothing synchronous over the whole file runs on
 * the calling event loop. An answer comes after the worker has exited, so the copy has no open handle then; a stop or
 * a timeout answers null at once, and `checkExited` tells when its worker is gone.
 *
 * @param options the worker entry, the migrations and the timeout
 * @returns the checker
 */
export function createBackupChecker(options: BackupCheckerOptions): BackupChecker {
  return (path, signal) => new BackupCheck(options, { path, migrationsFolder: options.migrationsFolder }).run(signal);
}

/** One check in one worker: the first of answer, error, exit, timeout or stop settles it. */
class BackupCheck {
  /** The worker, once started. */
  private worker: Worker | null = null;
  /** The answer once one came. */
  private answer: SnapshotFacts | null = null;
  /** Whether the check has settled. */
  private settled = false;
  /** Answers the caller; set while `run` waits. */
  private resolveRun: (() => void) | null = null;

  /**
   * @param options the worker entry and the timeout
   * @param request what the worker is started with
   */
  constructor(
    private readonly options: BackupCheckerOptions,
    private readonly request: BackupCheckRequest,
  ) {}

  /**
   * Runs the check.
   *
   * @param signal stops the check
   * @returns the facts, or null; never rejects
   */
  run(signal: AbortSignal | undefined): Promise<SnapshotFacts | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.stop(), this.options.timeoutMs ?? BACKUP_CHECK_TIMEOUT_MS);
      const onAbort = (): void => this.stop();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resolveRun = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(this.answer);
      };
      try {
        this.start();
      } catch {
        this.settled = true;
        this.finish();
      }
    });
  }

  /** Answers the caller once; later calls do nothing. */
  private finish(): void {
    const resolveRun = this.resolveRun;
    this.resolveRun = null;
    resolveRun?.();
  }

  /** Starts the worker and wires its events; an answer is given on its exit. */
  private start(): void {
    const worker = new Worker(this.options.workerUrl, { workerData: this.request });
    this.worker = worker;
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    trackExit(this.request.path, exited);
    void exited.then(() => this.finish());
    worker.once('message', (message: unknown) => {
      if (this.settled) return;
      this.settled = true;
      this.answer = isFacts(message) ? message : null;
      void worker.terminate();
    });
    worker.once('error', () => this.stop());
  }

  /** Ends the check without an answer at once: the timeout, a stop or a worker error; the worker exits later. */
  private stop(): void {
    if (this.settled) return;
    this.settled = true;
    this.answer = null;
    void this.worker?.terminate();
    this.finish();
  }
}

/**
 * Whether a worker message has the shape of the facts.
 *
 * @param message the message
 * @returns true for facts
 */
function isFacts(message: unknown): message is SnapshotFacts {
  if (typeof message !== 'object' || message === null) return false;
  const facts = message as Record<string, unknown>;
  return (
    typeof facts.workspaceId === 'string' &&
    (facts.lineageId === null || typeof facts.lineageId === 'string') &&
    Number.isInteger(facts.formatVersion) &&
    Number.isInteger(facts.appliedMigrations) &&
    typeof facts.newerThanApp === 'boolean'
  );
}
