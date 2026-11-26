import path from 'node:path';
import {
  WORKSPACE_FORMAT_VERSION,
  WorkspaceManifestSchema,
  type FileList,
  type FileTarget,
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
import { listFiles, recoverFileMoves, relocateFile } from './asset-files.js';
import { sweepTrash } from './file-trash.js';
import { ensureBuiltInAssetTypes } from './asset-types.js';
import { ensureBuiltInWorkflowTemplates } from './workflow-templates.js';
import { importArchive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, type ArchiveBudget } from './import-archive.js';
import { importFile, safeErrorMessage, type ImportContext } from './import-file.js';
import { isZipArchive } from './media-types.js';
import { MANIFEST_PATH } from './paths.js';
import { recoverIncompleteImports } from './recover-imports.js';
import type { ArchiveReader, FileQuery, Storage, WorkspaceDatabase, WorkspaceHost } from './ports.js';
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

  listFiles(q: FileQuery): Promise<FileList> {
    return this.read((s) => listFiles(s, q));
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
      newId: () => this.host.newId(),
      now: () => this.host.now(),
    };
  }

  private async doCreate(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
    const storage = this.host.createStorage(input.rootPath);
    if (!(await storage.isReachable())) {
      throw new StorageUnreachableError(`Storage is not reachable: ${input.rootPath}`);
    }
    if (!(await storage.isEmptyOrMissing())) {
      throw new DirectoryNotEmptyError(`Directory is not empty: ${input.rootPath}`);
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
      throw new StorageUnreachableError(`Storage is not reachable: ${input.rootPath}`);
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
    const results: ImportResult[] = [];
    for (const sourcePath of sourcePaths) {
      const sourceName = sourcePath.split(/[\\/]/).pop() ?? '';
      if (options.unpackArchives === true && isZipArchive(sourceName)) {
        results.push(...(await importArchive(ctx, sourcePath, budget, place)));
        continue;
      }
      const result = await importFile(ctx, sourcePath);
      await place(result);
      results.push(result);
    }
    return results;
  }

  private requireOpen(): OpenWorkspace {
    if (!this.open_) throw new NoWorkspaceOpenError('No workspace is open');
    return this.open_;
  }

  private async readManifest(storage: Storage, rootPath: string): Promise<WorkspaceManifest> {
    const text = await storage.readText(MANIFEST_PATH);
    if (text === null) throw new WorkspaceNotFoundError(`No workspace found at ${rootPath}`);
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
      throw new WorkspaceDuplicateError(
        `This folder is a copy of the workspace at ${known.rootPath}, which still exists`,
      );
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
