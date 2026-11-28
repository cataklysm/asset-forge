import type { WorkspaceSummary } from '@assetforge/contracts';
import type { LineLog } from '../log-line.js';
import type { ImageProbe, VideoProbe } from './media-probes.js';
import type { ArchiveReader, SourceFiles } from './source-files.js';
import type { Storage } from './storage.js';
import type { WorkspaceDatabase } from './workspace-database.js';

// What the host (the desktop app, later the server) gives the workspace manager.

/** The known workspaces at app level, keyed by id. Implemented outside core. */
export interface WorkspaceRegistry {
  /**
   * Every known workspace.
   *
   * @returns the entries
   */
  list(): Promise<WorkspaceSummary[]>;
  /**
   * One known workspace.
   *
   * @param id the workspace
   * @returns the entry; null for an unknown id
   */
  get(id: string): Promise<WorkspaceSummary | null>;
  /**
   * Adds or replaces an entry, keyed by id.
   *
   * @param entry the entry
   */
  upsert(entry: WorkspaceSummary): Promise<void>;
  /**
   * Forgets an entry; no-op if unknown.
   *
   * @param id the workspace
   */
  remove(id: string): Promise<void>;
}

/** The host services the workspace manager is built on. Implemented outside core. */
export interface WorkspaceHost {
  /** The known workspaces. */
  registry: WorkspaceRegistry;
  /** The files an import reads. */
  sources: SourceFiles;
  /** The ZIP reader of the import. */
  archives: ArchiveReader;
  /** Measures images. */
  imageProbe: ImageProbe;
  /** Measures videos. */
  videoProbe: VideoProbe;
  /**
   * The storage of a workspace folder.
   *
   * @param rootPath the absolute path of the workspace folder
   * @returns the storage rooted there
   */
  createStorage(rootPath: string): Storage;
  /**
   * Opens the local database of a workspace; creates the file and applies migrations.
   *
   * @param workspaceId the workspace
   * @returns the open database
   */
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>;
  /**
   * Removes the local database of a workspace; no-op if missing.
   *
   * @param workspaceId the workspace
   */
  deleteDatabase(workspaceId: string): Promise<void>;
  /**
   * Recoverable removal of a workspace folder.
   *
   * @param rootPath the absolute path of the workspace folder
   */
  moveToTrash(rootPath: string): Promise<void>;
  /**
   * A new id.
   *
   * @returns a fresh UUID
   */
  newId(): string;
  /**
   * The current time.
   *
   * @returns now
   */
  now(): Date;
  /**
   * Writes one log line made by `logLine` or `errorLogLine` (the main console in the app); nothing is logged
   * without it. A line holds ids, counts and codes only, never a path, a name, a URL or a message.
   */
  log?: LineLog;
}
