import {
  WORKSPACE_FORMAT_VERSION,
  type FileList,
  type FileRecord,
  type FileTarget,
  type ImportProgress,
  type ImportResult,
  type WorkspaceManifest,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import { DirectoryNotEmptyError, NoWorkspaceOpenError, StorageUnreachableError, TrashFailedError } from './errors.js';
import { listFiles } from './asset-files.js';
import { planMeasurement, probeMeasurement, storeMeasurement } from './measure-file.js';
import { MANIFEST_PATH } from './paths.js';
import type { FileQuery } from './ports/file-repositories.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { SerialQueue } from './serial-queue.js';
import type { WorkspaceSession } from './session.js';
import { importSources } from './workspace-import.js';
import { holdsWorkspace, readManifest } from './workspace-manifest.js';
import { openWorkspaceDatabase, rejectCopy, type OpenWorkspace } from './workspace-open.js';

/**
 * Lifecycle and mutating operations (`create`, `open`, `close`, `remove`, `importFiles`,
 * `exclusive`) run one at a time through a single queue, so a close never lands in the
 * middle of a write. Reads (`list`, `current`, `listFiles`, `read`) do not queue. Public
 * methods only enqueue; the work lives in private unqueued methods that call each other.
 */
export class WorkspaceManager {
  private open_: OpenWorkspace | null = null;
  private readonly queue = new SerialQueue();
  /** The live progress of the running `importFiles`; set from the start of the work until it settles. */
  private importProgress_: ImportProgress | null = null;

  constructor(private readonly host: WorkspaceHost) {}

  list(): Promise<WorkspaceSummary[]> {
    return this.host.registry.list();
  }

  current(): WorkspaceSummary | null {
    return this.open_?.summary ?? null;
  }

  create(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
    return this.queue.run(() => this.doCreate(input));
  }

  open(input: { rootPath: string }): Promise<WorkspaceSummary> {
    return this.queue.run(() => this.doOpen(input));
  }

  close(): Promise<void> {
    return this.queue.run(() => this.doClose());
  }

  /**
   * Forgets a workspace: its registry entry and its local database. With `trashFolder` the
   * workspace folder goes to the operating system's trash first, so a failure there leaves
   * everything untouched. A folder that no longer holds this workspace is never trashed.
   */
  remove(input: { id: string; trashFolder: boolean }): Promise<{ folderTrashed: boolean }> {
    return this.queue.run(() => this.doRemove(input));
  }

  /**
   * Imports into the inbox, or with `target` into that asset (which must exist before anything is imported).
   * With `unpackArchives` every `.zip` source is unpacked into its entries instead of imported as a file.
   */
  importFiles(
    sourcePaths: string[],
    target: FileTarget | null = null,
    options: { unpackArchives?: boolean } = {},
  ): Promise<ImportResult[]> {
    return this.queue.run(() => this.doImportFiles(sourcePaths, target, options));
  }

  /** A copy of the running import's progress, or null when none runs. Does not queue. */
  importProgress(): ImportProgress | null {
    return this.importProgress_ === null ? null : { ...this.importProgress_ };
  }

  /**
   * Marks the running import to stop after the item in progress; what is imported stays. Does not queue.
   * False when no import runs.
   */
  cancelImport(): boolean {
    if (this.importProgress_ === null) return false;
    this.importProgress_.cancelling = true;
    return true;
  }

  listFiles(q: FileQuery): Promise<FileList> {
    return this.read((s) => listFiles(s, q));
  }

  /**
   * Measures a file like `measureFile`, but reads and probes outside the queue, so a slow probe never holds up
   * queued operations; only storing the result is queued. When the workspace that was read is no longer the open
   * one by then, nothing is written and the record as read is answered.
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

  /** Runs `fn` with the open workspace's session, without waiting for queued operations. */
  async read<T>(fn: (session: WorkspaceSession) => Promise<T>): Promise<T> {
    return fn(this.session());
  }

  /** Runs `fn` with the open workspace's session once every earlier queued operation has settled. */
  exclusive<T>(fn: (session: WorkspaceSession) => Promise<T>): Promise<T> {
    return this.queue.run(() => fn(this.session()));
  }

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
    };
  }

  private async doCreate(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
    const storage = this.host.createStorage(input.rootPath);
    if (!(await storage.isReachable())) {
      throw new StorageUnreachableError('Storage is not reachable');
    }
    if (!(await storage.isEmptyOrMissing())) {
      throw new DirectoryNotEmptyError('Directory is not empty');
    }
    await storage.ensureLayout();
    const manifest: WorkspaceManifest = {
      id: this.host.newId(),
      formatVersion: WORKSPACE_FORMAT_VERSION,
      name: input.name,
      createdAt: this.host.now().toISOString(),
    };
    await storage.writeText(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    return this.doOpen({ rootPath: input.rootPath });
  }

  private async doOpen(input: { rootPath: string }): Promise<WorkspaceSummary> {
    await this.doClose();
    const storage = this.host.createStorage(input.rootPath);
    if (!(await storage.isReachable())) {
      throw new StorageUnreachableError('Storage is not reachable');
    }
    const manifest = await readManifest(storage);
    await rejectCopy(this.host, manifest.id, input.rootPath);
    this.open_ = await openWorkspaceDatabase(this.host, storage, manifest, input.rootPath);
    return this.open_.summary;
  }

  private async doClose(): Promise<void> {
    const open = this.open_;
    if (!open) return;
    this.open_ = null;
    await open.database.close();
  }

  private async doRemove(input: { id: string; trashFolder: boolean }): Promise<{ folderTrashed: boolean }> {
    const entry = await this.host.registry.get(input.id);
    if (entry === null) return { folderTrashed: false };
    if (this.open_?.summary.id === input.id) await this.doClose();

    let folderTrashed = false;
    if (input.trashFolder && (await holdsWorkspace(this.host, entry.rootPath, input.id))) {
      try {
        await this.host.moveToTrash(entry.rootPath);
      } catch (cause) {
        throw new TrashFailedError('The workspace folder could not be moved to the trash', { cause });
      }
      folderTrashed = true;
    }
    await this.host.deleteDatabase(input.id);
    await this.host.registry.remove(input.id);
    return { folderTrashed };
  }

  private async doImportFiles(
    sourcePaths: string[],
    target: FileTarget | null,
    options: { unpackArchives?: boolean },
  ): Promise<ImportResult[]> {
    return importSources(this.host, this.session(), sourcePaths, target, options, (progress) => {
      this.importProgress_ = progress;
    });
  }

  private requireOpen(): OpenWorkspace {
    if (!this.open_) throw new NoWorkspaceOpenError('No workspace is open');
    return this.open_;
  }
}
