import { BACKUP_INTERVAL_MS, type BackupAttempt, type BackupState, type WorkspaceSummary } from '@assetforge/contracts';
import { lineageShortId, parseBackupName } from './backup-names.js';
import { failedAttempt, succeededAttempt, writeBackup, type BackupTarget } from './backup-write.js';
import { BackupError, NoWorkspaceOpenError } from './errors.js';
import type { BackupTimers } from './ports/workspace-backups.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceHost } from './ports/workspace-host.js';

// The regular backups of the open workspace: hourly while it changed, on demand, and once more when it is closed;
// one at a time, outside the manager's queue, so a slow place never holds up imports. And the final backup of a
// closed database before a remove. No attempt ever fails a close; each is recorded per workspace.

/** The backups of one open workspace. */
interface BackupSession {
  /** The workspace. */
  summary: WorkspaceSummary;
  /** Its open database. */
  database: WorkspaceDatabase;
  /** The change count the last successful backup (or the open) was made at. */
  baseline: number;
  /** Whether a backup of the lineage exists in the place (or was written in this session). */
  hasBackup: boolean;
  /** Settles once `hasBackup` was looked up in the place; never rejects. */
  lineageCheck: Promise<void>;
  /** Set once the session is being ended; no new attempt starts then. */
  ending: boolean;
  /** The handle of the hourly timer; null while none is armed. */
  timer: unknown;
}

/** One running backup. */
interface RunningAttempt {
  /** Resolves with the recorded attempt; never rejects. */
  result: Promise<BackupAttempt>;
  /** Aborts the snapshot and the copy. */
  controller: AbortController;
  /** Set when a deadline cut the attempt off; its later outcome is then neither recorded nor logged. */
  abandoned: boolean;
  /** Settles once its snapshot settled (and a late one was discarded); resolved while no snapshot started. */
  snapshotPhase: Promise<void>;
}

/** A deadline that may be reached. */
interface Deadline {
  /** Resolves with `'deadline'` when it is reached; never when it has no time. */
  reached: Promise<'deadline'>;
  /** Whether it was reached. */
  passed: boolean;
  /** Stops the timer. */
  cancel(): void;
}

/** The global timers, which never keep the process alive. */
const GLOBAL_TIMERS: BackupTimers = {
  set: (callback, ms) => setTimeout(callback, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The backup service of the workspace manager. */
export class WorkspaceBackupService {
  private session: BackupSession | null = null;
  private running: RunningAttempt | null = null;
  private readonly attempts = new Map<string, BackupAttempt>();
  private readonly timers: BackupTimers;

  /**
   * @param host gives the backup port, the clock, the log and the timers
   */
  constructor(private readonly host: WorkspaceHost) {
    this.timers = host.timers ?? GLOBAL_TIMERS;
  }

  /**
   * Starts the backups of a workspace just opened; its change count now is the baseline.
   *
   * @param input the workspace, its database, and `hasSameLineageBackup` when it is known (a restore); otherwise
   *   the place is looked up in the background
   */
  startSession(input: {
    summary: WorkspaceSummary;
    database: WorkspaceDatabase;
    hasSameLineageBackup?: boolean;
  }): void {
    const session: BackupSession = {
      summary: input.summary,
      database: input.database,
      baseline: input.database.changeCount(),
      hasBackup: input.hasSameLineageBackup ?? false,
      lineageCheck: Promise.resolve(),
      ending: false,
      timer: null,
    };
    if (input.hasSameLineageBackup === undefined) session.lineageCheck = checkLineage(this.host, session);
    this.session = session;
    this.arm(session);
  }

  /**
   * Makes a backup of the open workspace now, even when it did not change; a running one is waited for first.
   *
   * @returns the recorded attempt
   * @throws NoWorkspaceOpenError when no workspace is open or it is being closed
   */
  async backupNow(): Promise<BackupAttempt> {
    const session = this.liveSession();
    while (this.running !== null) await this.running.result;
    if (!this.isLive(session)) throw new NoWorkspaceOpenError('No workspace is open');
    return this.start(session).result;
  }

  /**
   * Ends the backups of the open workspace: waits for a running backup, then makes the closing one when it changed.
   * After the deadline cut a backup off, it still waits until that backup's snapshot settled, so the database can be
   * closed; never for its copy. Never rejects; a failure is recorded.
   *
   * @param options `backupDeadlineMs` bounds the whole wait, `skip` leaves out the closing backup
   * @returns resolves once nothing runs any more (or the deadline passed and no snapshot runs)
   */
  async endSession(options: { backupDeadlineMs?: number; skip?: boolean }): Promise<void> {
    const session = this.session;
    if (session === null) return;
    session.ending = true;
    const deadline = this.startDeadline(options.backupDeadlineMs, () => this.running?.controller.abort());
    try {
      this.disarm(session);
      const work = this.closingWork(session, options.skip === true, deadline).catch(() => 'done' as const);
      const outcome = await Promise.race([work, deadline.reached]);
      if (outcome === 'deadline') await this.cutOff(session);
    } catch {
      // Ending never fails a close; what failed is recorded by the attempt.
    } finally {
      deadline.cancel();
      if (this.session === session) this.session = null;
    }
  }

  /**
   * Makes the final backup of a closed workspace from its database file, without opening it.
   *
   * @param target the workspace
   * @param deadlineMs bounds the backup; a cut-off fails it
   * @returns resolves once the backup is written
   * @throws BackupError with the reason; the attempt is recorded too
   */
  async finalBackup(target: BackupTarget, deadlineMs?: number): Promise<void> {
    const controller = new AbortController();
    const deadline = this.startDeadline(deadlineMs, () => controller.abort());
    const takeSnapshot = (signal: AbortSignal) => this.host.backups.snapshotClosed(target.id, signal);
    let snapshotPhase = Promise.resolve();
    const onSnapshotPhase = (settled: Promise<void>) => (snapshotPhase = settled);
    const work = writeBackup(this.host, target, takeSnapshot, controller.signal, onSnapshotPhase).then(
      () => 'done' as const,
    );
    work.catch(() => undefined); // A late failure after a cut-off is not reported twice.
    try {
      if ((await Promise.race([work, deadline.reached])) === 'deadline') {
        await snapshotPhase; // A following remove must not meet the file still open by the snapshot.
        throw new BackupError('backup_failed');
      }
      this.attempts.set(target.id, succeededAttempt(this.host));
    } catch (error) {
      const attempt = failedAttempt(this.host, target.id, error);
      this.attempts.set(target.id, attempt);
      throw error instanceof BackupError ? error : new BackupError(attempt.code ?? 'backup_failed', { cause: error });
    } finally {
      deadline.cancel();
    }
  }

  /**
   * The backup state of the open workspace.
   *
   * @returns the state; `workspaceId` null when none is open
   */
  state(): BackupState {
    const session = this.session;
    if (session === null) return { workspaceId: null, running: false, last: null };
    const id = session.summary.id;
    return { workspaceId: id, running: this.running !== null, last: this.lastAttempt(id) };
  }

  /**
   * The last attempt for a workspace in this app session.
   *
   * @param workspaceId the workspace
   * @returns the attempt; null before the first
   */
  lastAttempt(workspaceId: string): BackupAttempt | null {
    return this.attempts.get(workspaceId) ?? null;
  }

  /**
   * The waiting part of `endSession`: the running backup, then the closing one when the database changed.
   *
   * @param session the session being ended
   * @param skip leaves out the closing backup
   * @param deadline stops a closing backup from starting once it passed
   * @returns `'done'` once nothing runs
   */
  private async closingWork(session: BackupSession, skip: boolean, deadline: Deadline): Promise<'done'> {
    while (this.running !== null) await this.running.result;
    if (skip || deadline.passed || !(await this.changed(session)) || deadline.passed) return 'done';
    await this.start(session).result;
    return 'done';
  }

  /**
   * One tick of the hourly timer: a backup when the session is still open and changed, then the timer again.
   *
   * @param session the session the timer was armed for
   * @returns resolves once the tick is done
   */
  private async tick(session: BackupSession): Promise<void> {
    session.timer = null;
    if (this.isLive(session) && this.running === null && (await this.changed(session))) {
      if (this.isLive(session) && this.running === null) {
        await this.start(session).result; // Arms the timer again when it settles.
        return;
      }
    }
    this.arm(session);
  }

  /**
   * Starts one backup of the open database; the timer is armed again once it ends.
   *
   * @param session the session
   * @returns the running attempt
   */
  private start(session: BackupSession): RunningAttempt {
    const attempt = {
      controller: new AbortController(),
      abandoned: false,
      snapshotPhase: Promise.resolve(),
    } as RunningAttempt;
    const { controller } = attempt;
    const takeSnapshot = (signal: AbortSignal) => session.database.snapshot({ signal });
    const onSnapshotPhase = (settled: Promise<void>) => (attempt.snapshotPhase = settled);
    attempt.result = writeBackup(this.host, session.summary, takeSnapshot, controller.signal, onSnapshotPhase).then(
      (changeCount) => this.settle(session, attempt, () => this.succeeded(session, changeCount)),
      (error: unknown) => this.settle(session, attempt, () => failedAttempt(this.host, session.summary.id, error)),
    );
    this.running = attempt;
    return attempt;
  }

  /**
   * Records the end of an attempt, unless a deadline cut it off before.
   *
   * @param session the session
   * @param attempt the attempt
   * @param record makes the record (and logs a failure)
   * @returns the recorded attempt
   */
  private settle(session: BackupSession, attempt: RunningAttempt, record: () => BackupAttempt): BackupAttempt {
    if (attempt.abandoned) return this.lastAttempt(session.summary.id) ?? record();
    if (this.running === attempt) this.running = null;
    const recorded = record();
    this.attempts.set(session.summary.id, recorded);
    if (this.isLive(session)) this.arm(session);
    return recorded;
  }

  /**
   * The record of a successful backup; the session counts from its change count on.
   *
   * @param session the session
   * @param changeCount the change count the snapshot was taken at
   * @returns the attempt
   */
  private succeeded(session: BackupSession, changeCount: number): BackupAttempt {
    session.baseline = changeCount;
    session.hasBackup = true;
    return succeededAttempt(this.host);
  }

  /**
   * Gives up the running backup once the deadline of a close passed; it is recorded as failed.
   *
   * @param session the session being ended
   * @returns resolves once the snapshot of the given-up backup settled (the database may be closed then)
   */
  private async cutOff(session: BackupSession): Promise<void> {
    const attempt = this.running;
    if (attempt === null) return;
    attempt.abandoned = true;
    this.running = null;
    this.attempts.set(
      session.summary.id,
      failedAttempt(this.host, session.summary.id, new BackupError('backup_failed')),
    );
    await attempt.snapshotPhase;
  }

  /**
   * Whether the database changed since the last backup, or no backup of its lineage exists yet.
   *
   * @param session the session
   * @returns true when a backup is due
   */
  private async changed(session: BackupSession): Promise<boolean> {
    if (session.database.changeCount() !== session.baseline) return true;
    await session.lineageCheck;
    return !session.hasBackup;
  }

  /**
   * Arms the hourly timer of a session, replacing one that is armed.
   *
   * @param session the session
   */
  private arm(session: BackupSession): void {
    if (!this.isLive(session)) return;
    this.disarm(session);
    session.timer = this.timers.set(() => void this.tick(session), BACKUP_INTERVAL_MS);
  }

  /**
   * Stops the hourly timer of a session.
   *
   * @param session the session
   */
  private disarm(session: BackupSession): void {
    if (session.timer === null) return;
    this.timers.clear(session.timer);
    session.timer = null;
  }

  /**
   * A deadline over the backup timers.
   *
   * @param ms its time; none when undefined
   * @param onPassed runs when it passes
   * @returns the deadline
   */
  private startDeadline(ms: number | undefined, onPassed: () => void): Deadline {
    const deadline: Deadline = { reached: new Promise<'deadline'>(() => undefined), passed: false, cancel: () => {} };
    if (ms === undefined) return deadline;
    let handle: unknown = null;
    deadline.reached = new Promise<'deadline'>((resolve) => {
      handle = this.timers.set(() => {
        deadline.passed = true;
        onPassed();
        resolve('deadline');
      }, ms);
    });
    deadline.cancel = () => this.timers.clear(handle);
    return deadline;
  }

  /**
   * The open session, when it is not being ended.
   *
   * @returns the session
   * @throws NoWorkspaceOpenError otherwise
   */
  private liveSession(): BackupSession {
    if (this.session === null || this.session.ending) throw new NoWorkspaceOpenError('No workspace is open');
    return this.session;
  }

  /**
   * Whether a session is the open one and not being ended.
   *
   * @param session the session
   * @returns true while it is live
   */
  private isLive(session: BackupSession): boolean {
    return this.session === session && !session.ending;
  }
}

/**
 * Looks up whether the place already holds a backup of the database's lineage; sets `hasBackup` when it does. Any
 * failure counts as "a backup exists", so a place that is offline never forces a copy.
 *
 * @param host gives the backup port
 * @param session the session
 * @returns resolves once looked up; never rejects
 */
async function checkLineage(host: WorkspaceHost, session: BackupSession): Promise<void> {
  try {
    const lineageId = (await session.database.meta.get())?.lineageId ?? '';
    if (lineageId === '') {
      session.hasBackup = true; // Without a lineage there is nothing to look for.
      return;
    }
    const location = await host.backups.locationOf(session.summary);
    const shortId = lineageShortId(lineageId);
    const names = (await host.backups.list(location.directory)).map((file) => parseBackupName(file.name));
    if (names.some((parsed) => parsed?.lineageShortId === shortId)) session.hasBackup = true;
  } catch {
    session.hasBackup = true;
  }
}
