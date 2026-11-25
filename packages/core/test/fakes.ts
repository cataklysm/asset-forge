import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  Asset,
  AssetList,
  AssetType,
  FileList,
  FileRecord,
  ImportStatus,
  Project,
  ProjectList,
  WorkspaceSummary,
} from '@assetforge/contracts';
import { LAYOUT_DIRS } from '../src/paths.js';
import { InvalidOperationError, NotFoundError, SourceNotReadableError } from '../src/errors.js';
import type {
  AssetQuery,
  AssetRepository,
  AssetTypeRepository,
  FileRepository,
  Page,
  ProjectRepository,
  SourceFiles,
  Storage,
  StorageRef,
  StorageRepository,
  WorkspaceDatabase,
  WorkspaceHost,
  WorkspaceMeta,
  WorkspaceMetaRepository,
  WorkspaceRegistry,
} from '../src/ports.js';

/** In-memory storage. Files live in `files`, directories in `dirs` (relative, `/`-separated). */
export class InMemoryStorage implements Storage {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  reachable = true;
  /** When set, `hashFile` returns this value instead of the real hash. */
  hashOverride: string | null = null;
  private readonly failures = new Map<keyof Storage, Error>();

  /** The next call to `method` rejects with `error` (once). */
  failNext(method: keyof Storage, error: Error): void {
    this.failures.set(method, error);
  }

  private async guard(method: keyof Storage): Promise<void> {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  async isReachable(): Promise<boolean> {
    await this.guard('isReachable');
    return this.reachable;
  }

  async isEmptyOrMissing(): Promise<boolean> {
    await this.guard('isEmptyOrMissing');
    return this.files.size === 0 && this.dirs.size === 0;
  }

  async ensureLayout(): Promise<void> {
    await this.guard('ensureLayout');
    for (const dir of LAYOUT_DIRS) this.addDir(dir);
  }

  async readText(relPath: string): Promise<string | null> {
    await this.guard('readText');
    return this.files.get(relPath)?.toString('utf8') ?? null;
  }

  async writeText(relPath: string, text: string): Promise<void> {
    await this.guard('writeText');
    this.addParents(relPath);
    this.files.set(relPath, Buffer.from(text, 'utf8'));
  }

  async writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }> {
    await this.guard('writeStream');
    if (this.files.has(relPath)) {
      source.destroy();
      throw new Error(`Target exists: ${relPath}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    this.addParents(relPath);
    this.files.set(relPath, data);
    return { sizeBytes: data.length, sha256: sha256Of(data) };
  }

  async hashFile(relPath: string): Promise<string> {
    await this.guard('hashFile');
    const data = this.files.get(relPath);
    if (!data) throw new Error(`File not found: ${relPath}`);
    return this.hashOverride ?? sha256Of(data);
  }

  async move(from: string, to: string): Promise<void> {
    await this.guard('move');
    const data = this.files.get(from);
    if (!data) throw new Error(`File not found: ${from}`);
    if (this.files.has(to)) throw new Error(`Target exists: ${to}`);
    this.files.delete(from);
    this.addParents(to);
    this.files.set(to, data);
  }

  async exists(relPath: string): Promise<boolean> {
    await this.guard('exists');
    return this.files.has(relPath) || this.dirs.has(relPath);
  }

  async remove(relPath: string): Promise<void> {
    await this.guard('remove');
    this.files.delete(relPath);
  }

  async list(relDir: string): Promise<string[]> {
    await this.guard('list');
    const prefix = relDir === '' || relDir === '.' ? '' : `${relDir.replace(/\/+$/, '')}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === prefix) continue;
      names.add(path.slice(prefix.length).split('/')[0]!);
    }
    return [...names];
  }

  private addDir(dir: string): void {
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  private addParents(relPath: string): void {
    const idx = relPath.lastIndexOf('/');
    if (idx > 0) this.addDir(relPath.slice(0, idx));
  }
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

class InMemoryMeta implements WorkspaceMetaRepository {
  current: WorkspaceMeta | null = null;

  async get(): Promise<WorkspaceMeta | null> {
    return this.current;
  }

  async init(meta: WorkspaceMeta): Promise<void> {
    if (this.current !== null) throw new InvalidOperationError('The workspace row already exists');
    this.current = meta;
  }
}

class InMemoryStorages implements StorageRepository {
  readonly rows: StorageRef[] = [];

  async getPrimary(): Promise<StorageRef | null> {
    return this.rows[0] ?? null;
  }

  async ensurePrimary(r: { id: string; createdAt: string }): Promise<StorageRef> {
    if (this.rows.length === 0) this.rows.push({ id: r.id, kind: 'workspace_root', createdAt: r.createdAt });
    return this.rows[0]!;
  }
}

class InMemoryFiles implements FileRepository {
  readonly records = new Map<string, FileRecord>();

  async insertPending(r: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
  }): Promise<void> {
    this.records.set(r.id, {
      id: r.id,
      storageId: r.storageId,
      assetId: null,
      role: null,
      originalName: r.originalName,
      relativePath: r.relativePath,
      mimeType: r.mimeType,
      sizeBytes: null,
      sha256: null,
      status: 'pending',
      error: null,
      importedAt: r.importedAt,
    });
  }

  async markComplete(id: string, r: { sizeBytes: number; sha256: string }): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'complete', sizeBytes: r.sizeBytes, sha256: r.sha256, error: null });
  }

  async markFailed(id: string, error: string): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'failed', error });
  }

  async findCompleteBySha256(sha256: string): Promise<FileRecord[]> {
    return [...this.records.values()].filter((r) => r.status === 'complete' && r.sha256 === sha256);
  }

  async listByStatus(status: ImportStatus): Promise<FileRecord[]> {
    return [...this.records.values()].filter((r) => r.status === status);
  }

  async list(q: { limit: number; offset: number }): Promise<FileList> {
    const sorted = [...this.records.values()].sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : 0));
    return { items: sorted.slice(q.offset, q.offset + q.limit), total: sorted.length };
  }

  private require(id: string): FileRecord {
    const rec = this.records.get(id);
    if (!rec) throw new NotFoundError(`Unknown file id: ${id}`);
    return rec;
  }
}

class InMemoryAssetTypes implements AssetTypeRepository {
  readonly rows = new Map<string, AssetType>();

  async list(): Promise<AssetType[]> {
    return [...this.rows.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<AssetType | null> {
    return this.rows.get(id) ?? null;
  }

  async insertMissing(types: AssetType[]): Promise<void> {
    for (const t of types) {
      if (![...this.rows.values()].some((r) => r.key === t.key)) this.rows.set(t.id, t);
    }
  }
}

const byNameThenId = <T extends { name: string; id: string }>(a: T, b: T) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

class InMemoryProjects implements ProjectRepository {
  readonly rows = new Map<string, Project>();

  async insert(project: Project): Promise<void> {
    this.rows.set(project.id, project);
  }

  async get(id: string): Promise<Project | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string },
  ): Promise<Project | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...definedOnly(patch) };
    this.rows.set(id, next);
    return next;
  }

  async list(q: Page): Promise<ProjectList> {
    const sorted = [...this.rows.values()].sort(byNameThenId);
    const items = sorted.slice(q.offset, q.offset + q.limit).map((p) => ({ ...p, assetCount: 0 }));
    return { items, total: sorted.length };
  }
}

class InMemoryAssets implements AssetRepository {
  readonly rows = new Map<string, Asset>();

  async insert(asset: Asset): Promise<void> {
    this.rows.set(asset.id, asset);
  }

  async get(id: string): Promise<Asset | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...definedOnly(patch) };
    this.rows.set(id, next);
    return next;
  }

  async list(q: AssetQuery): Promise<AssetList> {
    const needle = q.nameContains?.toLowerCase();
    const matching = [...this.rows.values()]
      .filter((a) => q.typeId === undefined || a.typeId === q.typeId)
      .filter((a) => q.status === undefined || a.status === q.status)
      .filter((a) => needle === undefined || a.name.toLowerCase().includes(needle))
      .sort(byNameThenId);
    const items = matching.slice(q.offset, q.offset + q.limit).map((a) => ({ ...a, projectCount: 0, fileCount: 0 }));
    return { items, total: matching.length };
  }
}

export class InMemoryDatabase implements WorkspaceDatabase {
  readonly meta = new InMemoryMeta();
  readonly storages = new InMemoryStorages();
  readonly files = new InMemoryFiles();
  readonly assetTypes = new InMemoryAssetTypes();
  readonly projects = new InMemoryProjects();
  readonly assets = new InMemoryAssets();
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class InMemoryRegistry implements WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceSummary>();

  async list(): Promise<WorkspaceSummary[]> {
    return [...this.entries.values()];
  }

  async get(id: string): Promise<WorkspaceSummary | null> {
    return this.entries.get(id) ?? null;
  }

  async upsert(entry: WorkspaceSummary): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/** Maps absolute source paths to file contents. */
export class FakeSourceFiles extends Map<string, Buffer> implements SourceFiles {
  /** Paths that exist but cannot be read (e.g. directories). */
  readonly unreadable = new Set<string>();

  async open(absolutePath: string): Promise<{ name: string; stream: Readable }> {
    const data = this.get(absolutePath);
    if (!data || this.unreadable.has(absolutePath)) throw new SourceNotReadableError(`Cannot read source: ${absolutePath}`);
    const name = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
    return { name, stream: Readable.from([data]) };
  }
}

export function createFakeHost(): {
  host: WorkspaceHost;
  storages: Map<string, InMemoryStorage>;
  databases: Map<string, InMemoryDatabase>;
  sources: FakeSourceFiles;
  trash: { paths: string[]; failNext: boolean };
} {
  const trash = { paths: [] as string[], failNext: false };
  const storages = new Map<string, InMemoryStorage>();
  const databases = new Map<string, InMemoryDatabase>();
  const sources = new FakeSourceFiles();
  const host: WorkspaceHost = {
    registry: new InMemoryRegistry(),
    sources,
    createStorage(rootPath) {
      let storage = storages.get(rootPath);
      if (!storage) {
        storage = new InMemoryStorage();
        storages.set(rootPath, storage);
      }
      return storage;
    },
    async openDatabase(workspaceId) {
      let db = databases.get(workspaceId);
      if (!db) {
        db = new InMemoryDatabase();
        databases.set(workspaceId, db);
      }
      db.closed = false;
      return db;
    },
    async deleteDatabase(workspaceId) {
      databases.delete(workspaceId);
    },
    async moveToTrash(rootPath) {
      if (trash.failNext) {
        trash.failNext = false;
        throw new Error(`EBUSY: resource busy, rmdir '${rootPath}'`);
      }
      storages.delete(rootPath);
      trash.paths.push(rootPath);
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
  return { host, storages, databases, sources, trash };
}
