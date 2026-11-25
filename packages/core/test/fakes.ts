import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FileList, FileRecord, ImportStatus, WorkspaceSummary } from '@assetforge/contracts';
import { LAYOUT_DIRS } from '../src/paths.js';
import { SourceNotReadableError } from '../src/errors.js';
import type {
  FileRepository,
  SourceFiles,
  Storage,
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
    this.current = meta;
  }
}

class InMemoryFiles implements FileRepository {
  readonly records = new Map<string, FileRecord>();

  async insertPending(r: {
    id: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
  }): Promise<void> {
    this.records.set(r.id, {
      id: r.id,
      assetId: null,
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
    if (!rec) throw new Error(`Unknown file id: ${id}`);
    return rec;
  }
}

export class InMemoryDatabase implements WorkspaceDatabase {
  readonly meta = new InMemoryMeta();
  readonly files = new InMemoryFiles();
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
