import { z } from 'zod';
import {
  ApprovalStatusSchema,
  AssetAssignmentSchema,
  AssignmentPrioritySchema,
  DescriptionInputSchema,
  IntendedUseInputSchema,
  NameInputSchema,
  NotesInputSchema,
  ProjectAssignmentSchema,
  ProjectListSchema,
  ProjectMemberListSchema,
  ProjectSchema,
  ProjectStatusSchema,
} from './library';
import { PageRequestSchema } from './paging';
import { type ChannelContracts, IdRequestSchema, IdSchema } from './ipc-shared';

const AssignmentKeySchema = z.object({ projectId: IdSchema, assetId: IdSchema });

export const projectChannels = {
  'projects:list': {
    request: PageRequestSchema.extend({
      query: z.string().max(200).optional(),
      status: ProjectStatusSchema.optional(),
      tagNames: z.array(z.string().max(200)).max(10).optional(),
    }),
    response: ProjectListSchema,
  },
  'projects:get': {
    request: IdRequestSchema,
    response: ProjectSchema,
  },
  'projects:create': {
    request: z.object({ name: NameInputSchema, description: DescriptionInputSchema.optional() }),
    response: ProjectSchema,
  },
  'projects:update': {
    request: z.object({
      id: IdSchema,
      patch: z
        .object({
          name: NameInputSchema.optional(),
          description: DescriptionInputSchema.optional(),
          status: ProjectStatusSchema.optional(),
        })
        .strict(),
    }),
    response: ProjectSchema,
  },
  'assignments:listByAsset': {
    request: z.object({ assetId: IdSchema }),
    response: z.array(AssetAssignmentSchema),
  },
  'assignments:listByProject': {
    request: PageRequestSchema.extend({ projectId: IdSchema }),
    response: ProjectMemberListSchema,
  },
  'assignments:assign': {
    request: AssignmentKeySchema,
    response: ProjectAssignmentSchema,
  },
  'assignments:update': {
    request: AssignmentKeySchema.extend({
      patch: z
        .object({
          priority: AssignmentPrioritySchema.optional(),
          intendedUse: IntendedUseInputSchema.optional(),
          approvalStatus: ApprovalStatusSchema.optional(),
          notes: NotesInputSchema.optional(),
        })
        .strict(),
    }),
    response: ProjectAssignmentSchema,
  },
  'assignments:remove': {
    request: AssignmentKeySchema,
    response: z.null(),
  },
} as const satisfies ChannelContracts;
