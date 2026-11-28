import { Worker } from 'node:worker_threads';
import type { SnapshotFacts } from '@assetforge/core';

/**
 * Checks a local copy of a workspace database and reads its facts. The copy is folded into one file (no side files
 * are left), so it may be renamed or streamed afterwards.
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

/**
 * A checker that runs every check in a worker thread of its own, so nothing synchronous over the whole file runs on
 * the calling event loop. The answer comes only after the worker has exited, so the copy has no open handle then.
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
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(this.answer);
      };
      try {
        this.start(finish);
      } catch {
        this.settled = true;
        finish();
      }
    });
  }

  /**
   * Starts the worker and wires its events; the check settles on its exit.
   *
   * @param finish called once the worker has exited
   */
  private start(finish: () => void): void {
    const worker = new Worker(this.options.workerUrl, { workerData: this.request });
    this.worker = worker;
    worker.once('message', (message: unknown) => {
      if (this.settled) return;
      this.settled = true;
      this.answer = isFacts(message) ? message : null;
      void worker.terminate();
    });
    worker.once('error', () => this.stop());
    worker.once('exit', finish);
  }

  /** Ends the check without an answer: the timeout, a stop or a worker error. */
  private stop(): void {
    if (this.settled) return;
    this.settled = true;
    this.answer = null;
    void this.worker?.terminate();
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
