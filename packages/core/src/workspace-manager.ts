import path from 'node:path';
import {
  WORKSPACE_FORMAT_VERSION,
  WorkspaceManifestSchema,
  type FileList,
  type FileRecord,
  type FileTarget,
  type ImportProgress,
  type ImportResult,
  type WorkspaceManifest,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import {
  DirectoryNotEmptyError,
  InvalidManifestError,
  NotFoundError,
  NoWorkspaceOpenError,
  StorageUnreachableError,
  TrashFailedError,
  UnsupportedFormatVersionError,
  WorkspaceDuplicateError,
  WorkspaceMismatchError,
  WorkspaceNotFoundError,
} from './errors.js';
import { relocateFile } from './asset-files.js';
import { listFiles } from './file-list.js';
import { recoverFileMoves } from './file-move-recovery.js';
import { sweepTrash } from './trash-sweep.js';
import { ensureBuiltInAssetTypes } from './asset-types.js';
import { ensureBuiltInWorkflowTemplates } from './workflow-templates.js';
import { importArchive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, type ArchiveBudget } from './import-archive.js';
import { importFile, safeErrorMessage, type ImportContext } from './import-file.js';
import { isZipArchive } from './media-types.js';
import { planMeasurement, probeMeasurement, storeMeasurement } from './measure-file.js';
import { MANIFEST_PATH } from './paths.js';
import { recoverIncompleteImports } from './recover-imports.js';
import type { FileQuery } from './ports/file-repositories.js';
import type { ArchiveReader } from './ports/source-files.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { SerialQueue } from './serial-queue.js';
import type { WorkspaceSession } from './session.js';

/**
 * Roots that differ only by a trailing separator, `.` segments or (on Windows) letter
 * case name the same folder. Links or different drive mappings are not resolved here.
 */
function isSameRoot(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

interface OpenWorkspace {
  summary: WorkspaceSummary;
  storage: Storage;
  storageId: string;
  database: WorkspaceDatabase;
}

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
    const manifest = await this.readManifest(storage, input.rootPath);
    await this.rejectCopy(manifest.id, input.rootPath);

    const database = await this.host.openDatabase(manifest.id);
    try {
      const meta = await database.meta.get();
      if (meta === null) {
        await database.meta.init(manifest);
      } else if (meta.id !== manifest.id) {
        throw new WorkspaceMismatchError(
          `Database belongs to workspace ${meta.id}, but the manifest says ${manifest.id}`,
        );
      }
      const primary = await database.storages.ensurePrimary({
        id: this.host.newId(),
        createdAt: this.host.now().toISOString(),
      });
      await ensureBuiltInAssetTypes({ database, newId: () => this.host.newId() });
      await ensureBuiltInWorkflowTemplates({
        database,
        newId: () => this.host.newId(),
        now: () => this.host.now(),
      });
      await database.ensureDerivedData();
      await storage.ensureLayout();
      await this.recoverImports(storage, database);
      await recoverFileMoves({ storage, files: database.files, fileMoves: database.fileMoves });
      try {
        await sweepTrash({ storage, files: database.files });
      } catch {
        // Best effort: leftover trash binaries are swept on the next open.
      }
      const summary: WorkspaceSummary = {
        id: manifest.id,
        name: manifest.name,
        rootPath: input.rootPath,
        lastOpenedAt: this.host.now().toISOString(),
      };
      await this.host.registry.upsert(summary);
      this.open_ = { summary, storage, storageId: primary.id, database };
      return summary;
    } catch (error) {
      try {
        await database.close();
      } catch {
        // The error that made the open fail is the one worth reporting.
      }
      throw error;
    }
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
    if (input.trashFolder && (await this.holdsWorkspace(entry.rootPath, input.id))) {
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
    const session = this.session();
    if (target !== null && (await session.database.assets.get(target.assetId)) === null) {
      throw new NotFoundError(`Asset ${target.assetId} does not exist`);
    }
    const ctx: ImportContext & { archives: ArchiveReader } = {
      storage: session.storage,
      storageId: session.storageId,
      files: session.database.files,
      sources: this.host.sources,
      archives: this.host.archives,
      probe: this.host.imageProbe,
      newId: session.newId,
      now: session.now,
    };
    const place = async (result: ImportResult): Promise<void> => {
      if (target === null || result.file?.status !== 'complete') return;
      try {
        result.file = await relocateFile(session, result.file.id, target);
      } catch (error) {
        // The file stays in the inbox; the result reports why it was not placed.
        result.error = safeErrorMessage(error, 'Placing the file failed');
      }
    };
    const budget: ArchiveBudget = { entries: MAX_ARCHIVE_ENTRIES, bytes: MAX_ARCHIVE_BYTES };
    const progress: ImportProgress = { done: 0, total: sourcePaths.length, currentBytes: 0, currentSize: null, cancelling: false };
    const startItem = (size: number | null): void => {
      progress.currentBytes = 0;
      progress.currentSize = size;
    };
    const onProgress = (bytesWritten: number): void => {
      progress.currentBytes = bytesWritten;
    };
    // The finished item's bytes never outlive its count, so `done + fraction` never exceeds `total`.
    const finishItem = (): void => {
      progress.done += 1;
      startItem(null);
    };
    this.importProgress_ = progress;
    try {
      const results: ImportResult[] = [];
      for (const sourcePath of sourcePaths) {
        if (progress.cancelling) break;
        startItem(null);
        const sourceName = sourcePath.split(/[\\/]/).pop() ?? '';
        if (options.unpackArchives === true && isZipArchive(sourceName)) {
          // Until its directory is read the archive is one item; then each entry with a result is one.
          let expanded = false;
          const archiveResults = await importArchive(ctx, sourcePath, budget, place, {
            onEntries: (count) => {
              expanded = true;
              progress.total += count - 1;
            },
            isCancelled: () => progress.cancelling,
            onEntryStart: (declaredSize) => startItem(declaredSize),
            onProgress,
            onEntryDone: finishItem,
          });
          if (!expanded) finishItem();
          results.push(...archiveResults);
          continue;
        }
        const result = await importFile(ctx, sourcePath, {
          onSize: (sizeBytes) => {
            progress.currentSize = sizeBytes;
          },
          onProgress,
        });
        await place(result);
        results.push(result);
        finishItem();
      }
      return results;
    } finally {
      this.importProgress_ = null;
    }
  }

  private requireOpen(): OpenWorkspace {
    if (!this.open_) throw new NoWorkspaceOpenError('No workspace is open');
    return this.open_;
  }

  private async readManifest(storage: Storage, rootPath: string): Promise<WorkspaceManifest> {
    const text = await storage.readText(MANIFEST_PATH);
    if (text === null) throw new WorkspaceNotFoundError('No workspace found there');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new InvalidManifestError('Workspace manifest is not valid JSON', { cause });
    }
    const parsed = WorkspaceManifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new InvalidManifestError('Workspace manifest is invalid', { cause: parsed.error });
    }
    if (parsed.data.formatVersion > WORKSPACE_FORMAT_VERSION) {
      throw new UnsupportedFormatVersionError(
        `Workspace format ${parsed.data.formatVersion} is newer than supported ${WORKSPACE_FORMAT_VERSION}`,
      );
    }
    return parsed.data;
  }

  /**
   * A workspace id is known under one root. Opening it under another root is a move when
   * the old root no longer holds this workspace, and a copy when it still does; a copy
   * would share the database of the original, so it is rejected before anything changes.
   */
  private async rejectCopy(id: string, rootPath: string): Promise<void> {
    const known = await this.host.registry.get(id);
    if (known === null || isSameRoot(known.rootPath, rootPath)) return;
    if (await this.holdsWorkspace(known.rootPath, id)) {
      throw new WorkspaceDuplicateError('This workspace is already known');
    }
  }

  /** True only if `rootPath` is reachable and has a valid manifest with this id. */
  private async holdsWorkspace(rootPath: string, id: string): Promise<boolean> {
    try {
      const storage = this.host.createStorage(rootPath);
      if (!(await storage.isReachable())) return false;
      const text = await storage.readText(MANIFEST_PATH);
      if (text === null) return false;
      const parsed = WorkspaceManifestSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.id === id;
    } catch {
      return false;
    }
  }

  private async recoverImports(storage: Storage, database: WorkspaceDatabase): Promise<void> {
    await recoverIncompleteImports({ storage, files: database.files });
  }
}
