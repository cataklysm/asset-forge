import { z } from 'zod';
import { FileListFilterSchema } from './analysis';
import { AssignManyResultSchema, FileIdsSchema, FileListSchema, FileRecordSchema, FileRecordsSchema } from './files';
import { FileRoleSchema } from './library';
import { PageRequestSchema } from './paging';
import { type ChannelContracts, ChosenIdsSchema, IdSchema } from './ipc-shared';

/** The file channels: lists, assignment to assets, file tags, measuring and handing a file to the system. */
export const fileChannels = {
  'files:list': {
    /** `hasProposal` and `ids` are list filters only; they are not part of `FileListFilter` in an analysis target. */
    request: PageRequestSchema.extend(FileListFilterSchema.shape).extend({
      hasProposal: z.boolean().optional(),
      ids: ChosenIdsSchema.optional(),
    }),
    response: FileListSchema,
  },
  'files:assign': {
    request: z.object({ fileId: IdSchema, assetId: IdSchema, role: FileRoleSchema }),
    response: FileRecordSchema,
  },
  'files:unassign': {
    request: z.object({ fileId: IdSchema }),
    response: FileRecordSchema,
  },
  /** Assigns each file on its own, in request order; one failing file does not stop the others. */
  'files:assignMany': {
    request: z.object({ fileIds: FileIdsSchema, assetId: IdSchema, role: FileRoleSchema }),
    response: AssignManyResultSchema,
  },
  'files:addTag': {
    request: z.object({ fileId: IdSchema, name: z.string().max(200) }),
    response: FileRecordSchema,
  },
  'files:removeTag': {
    request: z.object({ fileId: IdSchema, name: z.string().max(200) }),
    response: FileRecordSchema,
  },
  /** All or nothing: tags every file or, when one is unknown or not complete, none. */
  'files:addTagMany': {
    request: z.object({ fileIds: FileIdsSchema, name: z.string().max(200) }),
    response: FileRecordsSchema,
  },
  /** All or nothing like `files:addTagMany`; a file without the tag is left alone. */
  'files:removeTagMany': {
    request: z.object({ fileIds: FileIdsSchema, name: z.string().max(200) }),
    response: FileRecordsSchema,
  },
  /** Measures a complete image or video without stored dimensions (a video also its duration); returns the (possibly unchanged) record. */
  'files:measure': {
    request: z.object({ fileId: IdSchema }),
    response: FileRecordSchema,
  },
  'files:openExternal': {
    request: z.object({ fileId: IdSchema }),
    response: z.null(),
  },
  'files:showInFolder': {
    request: z.object({ fileId: IdSchema }),
    response: z.null(),
  },
} as const satisfies ChannelContracts;
