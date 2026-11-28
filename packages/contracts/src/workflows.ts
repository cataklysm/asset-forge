import { z } from 'zod';
import { CountSchema, IdSchema } from './ipc-shared';

const id = IdSchema;
const timestamp = z.iso.datetime();

/** The state of one workflow step; independent of the asset status and of any job status. */
export const WorkflowStepStateSchema = z.enum(['not_started', 'in_progress', 'done', 'skipped']);
/** The state of one workflow step. */
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

/** `done` mandatory steps out of `total` mandatory steps. */
export const WorkflowProgressSchema = z.object({
  done: CountSchema,
  total: CountSchema,
});
/** The progress of a workflow. */
export type WorkflowProgress = z.infer<typeof WorkflowProgressSchema>;

/** A workflow template with the number of its latest version. */
export const WorkflowTemplateSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  latestVersion: z.number().int().min(1),
});
/** A workflow template. */
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/** One step of an asset's workflow with its state and notes. */
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
/** One step of an asset's workflow. */
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
  /** By position. */
  steps: z.array(WorkflowStepSchema),
});
/** The workflow of one asset. */
export type AssetWorkflow = z.infer<typeof AssetWorkflowSchema>;

/** The notes of a workflow step: at most 5000 characters. */
export const StepNotesInputSchema = z.string().max(5000);
/** The notes of a workflow step. */
export type StepNotesInput = z.infer<typeof StepNotesInputSchema>;
