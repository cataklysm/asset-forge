import type { WorkspaceSummary } from '@assetforge/contracts';
import type { ImageProbe, VideoProbe } from './ports/media-probes.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';

/** What a use case gets to work with while a workspace is open. */
export interface WorkspaceSession {
  readonly summary: WorkspaceSummary;
  readonly storage: Storage;
  /** ID of the workspace's primary storage row. */
  readonly storageId: string;
  readonly database: WorkspaceDatabase;
  readonly imageProbe: ImageProbe;
  readonly videoProbe: VideoProbe;
  newId(): string;
  now(): Date;
}
