import { z } from 'zod';
import { BackupListingSchema } from './backup';
import { WorkspaceSummarySchema } from './workspace';
import { type ChannelContracts, EmptyRequestSchema, IdSchema } from './ipc-shared';

/**
 * Names the workspace whose backups are listed: a known one by id, or a folder by its path (a folder whose database
 * is missing here). With `pickFolder` the main process also lists a folder the user picks in a native dialog.
 * Strict, so a request naming both or neither is refused.
 */
const BackupsRequestSchema = z.union([
  z.object({ id: IdSchema, pickFolder: z.boolean().optional() }).strict(),
  z.object({ rootPath: z.string().min(1), pickFolder: z.boolean().optional() }).strict(),
]);

/**
 * The workspace channels: list, create, open, close and remove workspaces, resolve the path of a new one, and list
 * and restore the backups of one.
 */
export const workspaceChannels = {
  'workspace:list': {
    request: EmptyRequestSchema,
    response: z.array(WorkspaceSummarySchema),
  },
  'workspace:current': {
    request: EmptyRequestSchema,
    response: WorkspaceSummarySchema.nullable(),
  },
  'workspace:create': {
    request: z.object({ name: z.string().min(1).max(200), rootPath: z.string() }),
    response: WorkspaceSummarySchema,
  },
  /** Resolves the directory a new workspace with this name would get inside `parentPath`. */
  'workspace:resolveCreatePath': {
    request: z.object({ name: z.string().min(1).max(200), parentPath: z.string().min(1) }),
    response: z.string(),
  },
  /**
   * Opens a workspace folder. A folder whose database is missing here answers `workspace_database_missing`, unless
   * `startEmpty` asks for a new, empty database.
   */
  'workspace:open': {
    request: z.object({ rootPath: z.string(), startEmpty: z.boolean().optional() }),
    response: WorkspaceSummarySchema,
  },
  /**
   * Removes a workspace from the application after the user confirmed it in a native
   * dialog owned by the host. `removed` is false when the user cancelled.
   */
  'workspace:remove': {
    request: z.object({ id: IdSchema }),
    response: z.object({ removed: z.boolean(), folderTrashed: z.boolean() }),
  },
  'workspace:close': {
    request: EmptyRequestSchema,
    response: z.null(),
  },
  /** The backups of a workspace, newest first, each with an opaque id; works without an open workspace. */
  'workspace:backups': {
    request: BackupsRequestSchema,
    response: BackupListingSchema,
  },
  /**
   * Replaces the database of a workspace folder that is not open with a backup of the latest listing, then opens
   * it; works without an open workspace.
   */
  'workspace:restore': {
    request: z.object({ rootPath: z.string().min(1), backupId: IdSchema }).strict(),
    response: WorkspaceSummarySchema,
  },
} as const satisfies ChannelContracts;
