import { z } from 'zod';
import { WorkspaceSummarySchema } from './workspace';
import { type ChannelContracts, EmptyRequestSchema, IdSchema } from './ipc-shared';

/** The workspace channels: list, create, open, close and remove workspaces and resolve the path of a new one. */
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
  'workspace:open': {
    request: z.object({ rootPath: z.string() }),
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
} as const satisfies ChannelContracts;
