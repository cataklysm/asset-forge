import type { Readable } from 'node:stream';
import type {
  Asset,
  AssetList,
  AssetStatus,
  AssetType,
  FileList,
  FileRecord,
  ImportStatus,
  Project,
  ProjectList,
  WorkspaceSummary,
} from '@assetforge/contracts';

export interface Storage {
  isReachable(): Promise<boolean>; // root's parent volume/dir is accessible
  isEmptyOrMissing(): Promise<boolean>; // root does not exist or has no entries
  ensureLayout(): Promise<void>; // creates root and LAYOUT_DIRS
  readText(relPath: string): Promise<string | null>; // null if missing
  writeText(relPath: string, text: string): Promise<void>; // atomic: temp file + rename
  writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }>;
  hashFile(relPath: string): Promise<string>; // lowercase hex SHA-256
  move(from: string, to: string): Promise<void>; // rejects if `to` exists
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>; // no-op if missing
  list(relDir: string): Promise<string[]>; // entry names; [] if dir missing
}

export interface SourceFiles {
  open(absolutePath: string): Promise<{ name: string; stream: Readable }>; // rejects with SourceNotReadableError
}

export interface StorageRef {
  id: string;
  kind: 'workspace_root';
  createdAt: string;
}

export interface StorageRepository {
  getPrimary(): Promise<StorageRef | null>;
  /** Returns the existing primary storage, or inserts and returns one built from `r`. */
  ensurePrimary(r: { id: string; createdAt: string }): Promise<StorageRef>;
}

export interface FileRepository {
  insertPending(r: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
  }): Promise<void>;
  markComplete(id: string, r: { sizeBytes: number; sha256: string }): Promise<void>; // rejects with NotFoundError for an unknown id
  markFailed(id: string, error: string): Promise<void>; // rejects with NotFoundError for an unknown id
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  list(q: { limit: number; offset: number }): Promise<FileList>; // newest importedAt first
}

export interface Page {
  limit: number;
  offset: number;
}

export interface AssetTypeRepository {
  list(): Promise<AssetType[]>; // by sortOrder, then name
  get(id: string): Promise<AssetType | null>;
  insertMissing(types: AssetType[]): Promise<void>; // skips rows whose key already exists
}

export interface ProjectRepository {
  insert(project: Project): Promise<void>;
  get(id: string): Promise<Project | null>;
  update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string },
  ): Promise<Project | null>;
  list(q: Page): Promise<ProjectList>; // by name (case-insensitive), then id
}

export interface AssetQuery extends Page {
  typeId?: string;
  status?: AssetStatus;
  projectId?: string;
  nameContains?: string;
}

export interface AssetRepository {
  insert(asset: Asset): Promise<void>;
  get(id: string): Promise<Asset | null>;
  update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null>;
  list(q: AssetQuery): Promise<AssetList>; // by name (case-insensitive), then id
}

export interface WorkspaceMeta {
  id: string;
  formatVersion: number;
  name: string;
  createdAt: string;
}

export interface WorkspaceMetaRepository {
  get(): Promise<WorkspaceMeta | null>;
  init(meta: WorkspaceMeta): Promise<void>; // rejects with InvalidOperationError when a row exists
}

export interface WorkspaceDatabase {
  meta: WorkspaceMetaRepository;
  storages: StorageRepository;
  files: FileRepository;
  assetTypes: AssetTypeRepository;
  projects: ProjectRepository;
  assets: AssetRepository;
  close(): Promise<void>;
}

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceSummary | null>;
  upsert(entry: WorkspaceSummary): Promise<void>; // keyed by id
  remove(id: string): Promise<void>; // no-op if unknown
}

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>; // creates the file and applies migrations
  deleteDatabase(workspaceId: string): Promise<void>; // removes the local database; no-op if missing
  moveToTrash(rootPath: string): Promise<void>; // recoverable removal of a workspace folder
  newId(): string;
  now(): Date;
}
