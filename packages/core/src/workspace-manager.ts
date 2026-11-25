import {
  WORKSPACE_FORMAT_VERSION,
  WorkspaceManifestSchema,
  type FileList,
  type ImportResult,
  type WorkspaceManifest,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import {
  DirectoryNotEmptyError,
  InvalidManifestError,
  NoWorkspaceOpenError,
  StorageUnreachableError,
  UnsupportedFormatVersionError,
  WorkspaceMismatchError,
  WorkspaceNotFoundError,
} from './errors.js';
import { MANIFEST_PATH } from './paths.js';
import type { Storage, WorkspaceDatabase, WorkspaceHost } from './ports.js';

interface OpenWorkspace {
  summary: WorkspaceSummary;
  storage: Storage;
  database: WorkspaceDatabase;
}

export class WorkspaceManager {
  private open_: OpenWorkspace | null = null;

  constructor(private readonly host: WorkspaceHost) {}

  list(): Promise<WorkspaceSummary[]> {
    return this.host.registry.list();
  }

  current(): WorkspaceSummary | null {
    return this.open_?.summary ?? null;
  }

  async create(input: { name: string; rootPath: string }): Promise<WorkspaceSummary> {
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
    return this.open({ rootPath: input.rootPath });
  }

  async open(input: { rootPath: string }): Promise<WorkspaceSummary> {
    await this.close();
    const storage = this.host.createStorage(input.rootPath);
    if (!(await storage.isReachable())) {
      throw new StorageUnreachableError(`Storage is not reachable: ${input.rootPath}`);
    }
    const manifest = await this.readManifest(storage, input.rootPath);

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
      await storage.ensureLayout();
      await this.recoverImports(storage, database);
      const summary: WorkspaceSummary = {
        id: manifest.id,
        name: manifest.name,
        rootPath: input.rootPath,
        lastOpenedAt: this.host.now().toISOString(),
      };
      await this.host.registry.upsert(summary);
      this.open_ = { summary, storage, database };
      return summary;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const open = this.open_;
    if (!open) return;
    this.open_ = null;
    await open.database.close();
  }

  async importFiles(sourcePaths: string[]): Promise<ImportResult[]> {
    this.requireOpen();
    void sourcePaths;
    throw new Error('importFiles is not implemented yet');
  }

  listFiles(q: { limit: number; offset: number }): Promise<FileList> {
    try {
      return this.requireOpen().database.files.list(q);
    } catch (error) {
      return Promise.reject(error);
    }
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

  /** Placeholder for startup import recovery; filled in by Task 7. */
  private async recoverImports(storage: Storage, database: WorkspaceDatabase): Promise<void> {
    void storage;
    void database;
  }
}
