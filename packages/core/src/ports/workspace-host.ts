import type { WorkspaceSummary } from '@assetforge/contracts';
import type { ImageProbe, VideoProbe } from './media-probes.js';
import type { ArchiveReader, SourceFiles } from './source-files.js';
import type { Storage } from './storage.js';
import type { WorkspaceDatabase } from './workspace-database.js';

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceSummary | null>;
  upsert(entry: WorkspaceSummary): Promise<void>; // keyed by id
  remove(id: string): Promise<void>; // no-op if unknown
}

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  archives: ArchiveReader;
  imageProbe: ImageProbe;
  videoProbe: VideoProbe;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>; // creates the file and applies migrations
  deleteDatabase(workspaceId: string): Promise<void>; // removes the local database; no-op if missing
  moveToTrash(rootPath: string): Promise<void>; // recoverable removal of a workspace folder
  newId(): string;
  now(): Date;
}
