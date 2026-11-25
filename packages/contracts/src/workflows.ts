import { z } from 'zod';

const id = z.uuid();
const timestamp = z.iso.datetime();

/** The state of one workflow step; independent of the asset status and of any job status. */
export const WorkflowStepStateSchema = z.enum(['not_started', 'in_progress', 'done', 'skipped']);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

/** `done` mandatory steps out of `total` mandatory steps. */
export const WorkflowProgressSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type WorkflowProgress = z.infer<typeof WorkflowProgressSchema>;

export const WorkflowTemplateSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  latestVersion: z.number().int().min(1),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

export const WorkflowStepSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  position: z.number().int().min(0),
  mandatory: z.boolean(),
  state: WorkflowStepStateSchema,
  notes: z.string(),
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/** The workflow of one asset, pinned to the template version it was started from. */
export const AssetWorkflowSchema = z.object({
  id,
  assetId: id,
  templateId: id,
  templateName: z.string(),
  templateVersion: z.number().int().min(1),
  createdAt: timestamp,
  progress: WorkflowProgressSchema,
  steps: z.array(WorkflowStepSchema), // by position
});
export type AssetWorkflow = z.infer<typeof AssetWorkflowSchema>;

export const StepNotesInputSchema = z.string().max(5000);
export type StepNotesInput = z.infer<typeof StepNotesInputSchema>;
