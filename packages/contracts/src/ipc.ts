import { z } from 'zod';
import { FileListSchema, ImportResultSchema } from './files';
import { WorkspaceSummarySchema } from './workspace';

export const IpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

const EmptyRequestSchema = z.object({});

export const ipcContract = {
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
    request: z.object({ id: z.uuid() }),
    response: z.object({ removed: z.boolean(), folderTrashed: z.boolean() }),
  },
  'workspace:close': {
    request: EmptyRequestSchema,
    response: z.null(),
  },
  'files:import': {
    request: z.object({ sourcePaths: z.array(z.string()).min(1).max(1000) }),
    response: z.array(ImportResultSchema),
  },
  'files:list': {
    request: z.object({
      limit: z.number().int().min(1).max(200),
      offset: z.number().int().min(0),
    }),
    response: FileListSchema,
  },
  'dialog:pickDirectory': {
    request: EmptyRequestSchema,
    response: z.string().nullable(),
  },
  'dialog:pickFiles': {
    request: EmptyRequestSchema,
    response: z.array(z.string()),
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof ipcContract;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['response']>;
