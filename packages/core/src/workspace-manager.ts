import {
  BACKUP_QUIT_DEADLINE_MS,
  type BackupAttempt,
  type BackupState,
  type FileList,
  type FileRecord,
  type FileTarget,
  type ImportProgress,
  type ImportResult,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import type { BackupFolderStatus, ListedBackup } from './backup-types.js';
import { DirectoryNotEmptyError, InvalidOperationError, NoWorkspaceOpenError, TrashFailedError } from './errors.js';
import { listFiles } from './file-list.js';
import { planMeasurement, probeMeasurement, storeMeasurement } from './measure-file.js';
import type { FileQuery } from './ports/file-repositories.js';
import type { BackupSource } from './ports/workspace-backups.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { SerialQueue } from './serial-queue.js';
import { WorkspaceBackupService } from './workspace-backup.js';
import type { WorkspaceSession } from './session.js';
import { importSources, newImportProgress, requireTargetAsset, type ImportSourcesOptions } from './workspace-import.js';
import { holdsWorkspace, newManifest, readManifest, writeManifest } from './workspace-manifest.js';
import { openWorkspaceDatabase, rejectCopy, requireReachable, type OpenWorkspace } from './workspace-open.js';

/**
 * Lifecycle and mutating operations (`create`, `open`, `close`, `remove`, `importFiles`,
 * `exclusive`) run one at a time through a single queue, so a close never lands in the
 * middle of a write. Reads (`list`, `current`, `listFiles`, `read`) do not queue. Public
 * methods only enqueue; the work lives in private unqueued methods that call each other.
 */
export class WorkspaceManager {
  private open_: OpenWorkspace | null = null;
  private readonly queue = new SerialQueue();
  /** The regular and final backups. */
  private readonly backups: WorkspaceBackupService;
  /** The live progress of the running `importFiles`; set from the start of the work until it settles. */
  private importProgress_: ImportProgress | null = null;

  /**
   * @param host the host services the workspaces are built on
   */
  constructor(private readonly host: WorkspaceHost) {
    this.backups = new WorkspaceBackupService(host);
  }

  /**
   * The known workspaces. Does not queue.
   *
   * @returns the registry entries
   */
  list(): Promise<WorkspaceSummary[]> {
    return this.host.registry.list();
  }

  /**
   * The open workspace. Does not queue.
   *
   * @returns its registry entry; null when none is open
   */
  current(): WorkspaceSummary | null {
    return this.open_?.summary ?? null;
  }

  /**
   * Creates a workspace in an empty or missing folder and opens it.
   *
   * @param input the workspace name and the folder
   * @returns the opened workspace
   */
  create(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
    return this.queue.run(() => this.doCreate(input));
  }

  /**
   * Opens the workspace in a folder; the open one is closed first.
   *
   * @param input the folder, and `startEmpty` to start with an empty database when the local one is missing
   * @returns the opened workspace
   */
  open(input: { rootPath: string; startEmpty?: boolean }): Promise<WorkspaceSummary> {
    return this.queue.run(() => this.doOpen(input));
  }

  /**
   * Closes the open workspace; no-op when none is open.
   *
   * @param options `backupDeadlineMs` bounds the final backup before the close
   * @returns resolves once it is closed
   */
  close(options?: { backupDeadlineMs?: number }): Promise<void> {
    const backupDeadlineMs = options?.backupDeadlineMs ?? BACKUP_QUIT_DEADLINE_MS;
    return this.queue.run(() => this.doClose({ backupDeadlineMs }));
  }

  /**
   * Forgets a workspace: its registry entry and its local database. With `trashFolder` the
   * workspace folder goes to the operating system's trash first, so a failure there leaves
   * everything untouched. A folder that no longer holds this workspace is never trashed.
   *
   * @param input the workspace id, whether its folder goes to the trash, and `skipFinalBackup` to remove it without
   *   the final backup
   * @returns whether the folder was trashed
   */
  remove(input: { id: string; trashFolder: boolean; skipFinalBackup?: boolean }): Promise<{ folderTrashed: boolean }> {
    return this.queue.run(() => this.doRemove(input));
  }

  /**
   * The backups a workspace can be restored from: the copies before pending migrations and the regular backups.
   *
   * @param request the workspace by id or folder, and a further directory the user picked
   * @returns the id of the workspace, its backups, newest first, and whether the backup place could not be listed
   */
  listBackups(request: {
    workspace: { id: string } | { rootPath: string };
    extraDirectory: string | null;
  }): Promise<{ workspaceId: string; backups: ListedBackup[]; unreachable: boolean }> {
    void request;
    return Promise.reject(notImplemented());
  }

  /**
   * Replaces the local database of a closed workspace by a backup and opens it.
   *
   * @param request the workspace folder and the backup
   * @returns the opened workspace
   */
  restore(request: { rootPath: string; source: BackupSource }): Promise<WorkspaceSummary> {
    void request;
    return Promise.reject(notImplemented());
  }

  /**
   * Makes a backup of the open workspace now.
   *
   * @returns the attempt
   */
  backupNow(): Promise<BackupAttempt> {
    return this.backups.backupNow();
  }

  /**
   * The backup state of the open workspace. Does not queue.
   *
   * @returns the state; `workspaceId` null when none is open
   */
  backupState(): BackupState {
    return this.backups.state();
  }

  /**
   * The state of the backup place of the open workspace.
   *
   * @returns the place, its backups and the last attempt
   */
  backupStatus(): Promise<BackupFolderStatus> {
    return Promise.reject(notImplemented());
  }

  /**
   * Deletes one regular backup of the open workspace.
   *
   * @param source the backup
   * @returns resolves once it is gone
   */
  deleteBackup(source: BackupSource): Promise<void> {
    void source;
    return Promise.reject(notImplemented());
  }

  /**
   * Imports into the inbox, or with `target` into that asset (which must exist before anything is imported).
   * With `unpackArchives` every `.zip` source is unpacked into its entries instead of imported as a file.
   *
   * @param sourcePaths the absolute paths of the sources
   * @param target the asset and role to import into; null for the inbox
   * @param options whether archives are unpacked
   * @returns one result per source, or per archive entry for an unpacked archive
   */
  importFiles(
    sourcePaths: string[],
    target: FileTarget | null = null,
    options: ImportSourcesOptions = {},
  ): Promise<ImportResult[]> {
    return this.queue.run(() => this.doImportFiles(sourcePaths, target, options));
  }

  /**
   * The running import's progress. Does not queue.
   *
   * @returns a copy of it, or null when none runs
   */
  importProgress(): ImportProgress | null {
    return this.importProgress_ === null ? null : { ...this.importProgress_ };
  }

  /**
   * Marks the running import to stop after the item in progress; what is imported stays. Does not queue.
   *
   * @returns false when no import runs
   */
  cancelImport(): boolean {
    if (this.importProgress_ === null) return false;
    this.importProgress_.cancelling = true;
    return true;
  }

  /**
   * One page of files of the open workspace. Does not queue.
   *
   * @param query the filter and the page
   * @returns the page
   */
  listFiles(query: FileQuery): Promise<FileList> {
    return this.read((session) => listFiles(session, query));
  }

  /**
   * Measures a file like `measureFile`, but reads and probes outside the queue, so a slow probe never holds up
   * queued operations; only storing the result is queued. When the workspace that was read is no longer the open
   * one by then, nothing is written and the record as read is answered.
   *
   * @param fileId the file
   * @returns the file record, with the measured size when it was stored
   */
  async measureFile(fileId: string): Promise<FileRecord> {
    const session = this.session();
    const { file, target } = await planMeasurement(session, fileId);
    if (target === null) return file;
    const size = await probeMeasurement(session, target);
    if (size === null) return file;
    return this.queue.run(async () => {
      if (this.open_ === null || this.open_.database !== session.database) return file;
      return storeMeasurement(this.session(), target, size);
    });
  }

  /**
   * Runs `work` with the open workspace's session, without waiting for queued operations.
   *
   * @param work the use case
   * @returns what `work` resolves to
   */
  async read<T>(work: (session: WorkspaceSession) => Promise<T>): Promise<T> {
    return work(this.session());
  }

  /**
   * Runs `work` with the open workspace's session once every earlier queued operation has settled.
   *
   * @param work the use case
   * @returns what `work` resolves to
   */
  exclusive<T>(work: (session: WorkspaceSession) => Promise<T>): Promise<T> {
    return this.queue.run(() => work(this.session()));
  }

  /**
   * The session handed to use cases.
   *
   * @returns the session of the open workspace; throws `NoWorkspaceOpenError` when none is open
   */
  private session(): WorkspaceSession {
    const { summary, storage, storageId, database } = this.requireOpen();
    return {
      summary,
      storage,
      storageId,
      database,
      imageProbe: this.host.imageProbe,
      videoProbe: this.host.videoProbe,
      newId: () => this.host.newId(),
      now: () => this.host.now(),
      log: this.host.log,
    };
  }

  /**
   * Writes the layout and the manifest of a new workspace, then opens it.
   *
   * @param input the workspace name and the folder
   * @returns the opened workspace
   */
  private async doCreate(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
    const storage = this.host.createStorage(input.rootPath);
    await requireReachable(storage);
    if (!(await storage.isEmptyOrMissing())) {
      throw new DirectoryNotEmptyError('Directory is not empty');
    }
    await storage.ensureLayout();
    await writeManifest(storage, newManifest(this.host, input.name));
    return this.doOpen({ rootPath: input.rootPath });
  }

  /**
   * Closes the open workspace, then opens the one in the folder.
   *
   * @param input the folder
   * @returns the opened workspace
   */
  private async doOpen(input: { rootPath: string }): Promise<WorkspaceSummary> {
    await this.doClose({ backupDeadlineMs: BACKUP_QUIT_DEADLINE_MS });
    const storage = this.host.createStorage(input.rootPath);
    await requireReachable(storage);
    const manifest = await readManifest(storage);
    await rejectCopy(this.host, manifest.id, input.rootPath);
    const open = await openWorkspaceDatabase(this.host, storage, manifest, input.rootPath);
    this.open_ = open;
    this.backups.startSession({ summary: open.summary, database: open.database });
    return open.summary;
  }

  /**
   * Closes the open workspace after its closing backup; no-op when none is open.
   *
   * @param options `backupDeadlineMs` bounds the closing backup, `skip` leaves it out
   * @returns resolves once its database is closed
   */
  private async doClose(options: { backupDeadlineMs?: number; skip?: boolean }): Promise<void> {
    const open = this.open_;
    if (!open) return;
    this.open_ = null;
    try {
      await this.backups.endSession(options);
    } finally {
      await open.database.close();
    }
  }

  /**
   * Forgets a workspace, closing it first when it is the open one.
   *
   * @param input the workspace id and whether its folder goes to the trash
   * @returns whether the folder was trashed
   */
  private async doRemove(input: { id: string; trashFolder: boolean }): Promise<{ folderTrashed: boolean }> {
    const entry = await this.host.registry.get(input.id);
    if (entry === null) return { folderTrashed: false };
    if (this.open_?.summary.id === input.id) await this.doClose({ skip: true });

    const folderTrashed = input.trashFolder && (await this.trashFolder(entry.rootPath, input.id));
    await this.host.deleteDatabase(input.id);
    await this.host.registry.remove(input.id);
    return { folderTrashed };
  }

  /**
   * Moves a workspace folder to the operating system's trash, but only while it still holds this workspace.
   *
   * @param rootPath the folder
   * @param id the workspace id
   * @returns true when the folder was trashed, false when it no longer holds the workspace
   * @throws `TrashFailedError` when the move fails
   */
  private async trashFolder(rootPath: string, id: string): Promise<boolean> {
    if (!(await holdsWorkspace(this.host, rootPath, id))) return false;
    try {
      await this.host.moveToTrash(rootPath);
    } catch (cause) {
      throw new TrashFailedError('The workspace folder could not be moved to the trash', { cause });
    }
    return true;
  }

  /**
   * Runs an import and keeps its live progress until it settles.
   *
   * @param sourcePaths the absolute paths of the sources
   * @param target the asset and role to import into; null for the inbox
   * @param options whether archives are unpacked
   * @returns the results of the import
   */
  private async doImportFiles(
    sourcePaths: string[],
    target: FileTarget | null,
    options: ImportSourcesOptions,
  ): Promise<ImportResult[]> {
    const session = this.session();
    await requireTargetAsset(session, target);
    const progress = newImportProgress(sourcePaths.length);
    this.importProgress_ = progress;
    try {
      return await importSources(this.host, session, sourcePaths, target, options, progress);
    } finally {
      this.importProgress_ = null;
    }
  }

  /**
   * The open workspace.
   *
   * @returns it; throws `NoWorkspaceOpenError` when none is open
   */
  private requireOpen(): OpenWorkspace {
    if (!this.open_) throw new NoWorkspaceOpenError('No workspace is open');
    return this.open_;
  }
}

/**
 * The error of a backup operation that is not built yet.
 *
 * @returns the error
 */
function notImplemented(): InvalidOperationError {
  return new InvalidOperationError('Not implemented');
}
