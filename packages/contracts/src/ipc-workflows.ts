import { z } from 'zod';
import {
  AssetWorkflowSchema,
  StepNotesInputSchema,
  WorkflowStepStateSchema,
  WorkflowTemplateSchema,
} from './workflows';
import { type ChannelContracts, EmptyRequestSchema, IdSchema } from './ipc-shared';

export const workflowChannels = {
  'workflowTemplates:list': {
    request: EmptyRequestSchema,
    response: z.array(WorkflowTemplateSchema),
  },
  'workflows:get': {
    request: z.object({ assetId: IdSchema }),
    response: AssetWorkflowSchema.nullable(),
  },
  'workflows:start': {
    request: z.object({ assetId: IdSchema, templateId: IdSchema.optional() }),
    response: AssetWorkflowSchema,
  },
  'workflows:updateStep': {
    request: z.object({
      stepId: IdSchema,
      patch: z
        .object({
          state: WorkflowStepStateSchema.optional(),
          notes: StepNotesInputSchema.optional(),
        })
        .strict(),
    }),
    response: AssetWorkflowSchema,
  },
  /** Removes the workflow of an asset after a native confirmation; `removed` is false when declined. */
  'workflows:remove': {
    request: z.object({ assetId: IdSchema }),
    response: z.object({ removed: z.boolean() }),
  },
} as const satisfies ChannelContracts;
