import { z } from 'zod';
import { FileTargetSchema, ImportProgressSchema, ImportResultSchema } from './files';
import { FileOriginSchema, IMPORT_URL_STRING_MAX, MAX_IMPORT_URLS, UrlImportResultSchema } from './url-import';
import { type ChannelContracts, EmptyRequestSchema, IdSchema } from './ipc-shared';

/** The import channels: files and URLs into the workspace, progress and cancel of an import, and file origins. */
export const importChannels = {
  'files:import': {
    request: z.object({
      sourcePaths: z.array(z.string()).min(1).max(1000),
      target: FileTargetSchema.optional(),
      /** Unpack every `.zip` source into its entries instead of importing it as a file. */
      unpackArchives: z.boolean().optional(),
    }),
    response: z.array(ImportResultSchema),
  },
  /** The progress of the running import; null when none runs or no workspace is open. Never waits for the queue. */
  'files:importProgress': {
    request: EmptyRequestSchema,
    response: ImportProgressSchema.nullable(),
  },
  /** Marks the running import to stop after the item in progress; `cancelling` is false when none runs. */
  'files:cancelImport': {
    request: EmptyRequestSchema,
    response: z.object({ cancelling: z.boolean() }),
  },
  /**
   * Queues one download job per usable line; `skipDuplicates` defaults to true. A line over the length
   * limit is reported as invalid, not refused by the schema; only a line over 10000 characters is refused.
   */
  'files:importUrls': {
    request: z.object({
      urls: z.array(z.string().max(IMPORT_URL_STRING_MAX)).min(1).max(MAX_IMPORT_URLS),
      target: FileTargetSchema.optional(),
      skipDuplicates: z.boolean().optional(),
    }),
    response: UrlImportResultSchema,
  },
  /** The addresses a file was downloaded from, oldest first. */
  'files:origins': {
    request: z.object({ fileId: IdSchema }),
    response: z.array(FileOriginSchema),
  },
  /** Opens a stored origin in the system browser; the renderer never passes the address itself. */
  'files:openOrigin': {
    request: z.object({ fileId: IdSchema, originId: IdSchema }),
    response: z.object({}),
  },
} as const satisfies ChannelContracts;
