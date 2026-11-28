import { z } from 'zod';
import { EmptyTrashResultSchema, FileBatchResultSchema, FileIdsSchema, TrashSummarySchema } from './files';
import { type ChannelContracts, EmptyRequestSchema } from './ipc-shared';

export const trashChannels = {
  /** Moves each complete file to the trash and removes each failed file outright; per item, in request order. */
  'files:trashMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  /** Moves each trashed file back to its asset and role, or to the inbox; per item. */
  'files:restoreMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  /** Removes each trashed file for good; per item, a purged item carries neither file nor error. */
  'files:purgeMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  'trash:empty': {
    request: EmptyRequestSchema,
    response: EmptyTrashResultSchema,
  },
  'trash:summary': {
    request: EmptyRequestSchema,
    response: TrashSummarySchema,
  },
} as const satisfies ChannelContracts;
