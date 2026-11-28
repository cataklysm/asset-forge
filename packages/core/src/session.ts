import type { WorkspaceSummary } from '@assetforge/contracts';
import type { ImageProbe, VideoProbe } from './ports/media-probes.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';

/** What a use case gets to work with while a workspace is open. */
export interface WorkspaceSession {
  /** The open workspace as the renderer sees it. */
  readonly summary: WorkspaceSummary;
  /** The workspace's primary storage. */
  readonly storage: Storage;
  /** ID of the workspace's primary storage row. */
  readonly storageId: string;
  /** The workspace's database. */
  readonly database: WorkspaceDatabase;
  /** Reads the size of an image. */
  readonly imageProbe: ImageProbe;
  /** Reads the size and duration of a video. */
  readonly videoProbe: VideoProbe;
  /**
   * A new unique id.
   *
   * @returns it
   */
  newId(): string;
  /**
   * The current time.
   *
   * @returns it
   */
  now(): Date;
}
