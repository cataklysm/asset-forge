import { z } from 'zod';
import { TagAssignmentSchema } from './tags';

export const PROMPT_TITLE_MAX = 120;
export const PROMPT_DESCRIPTION_MAX = 2000;
export const PROMPT_VARIABLE_NAME_MAX = 40;
export const MAX_PROMPT_VARIABLES = 20;
export const PROMPT_VARIABLE_VALUE_MAX = 2000;
export const MAX_PROMPT_TAGS = 50;

// Transport bounds are deliberately wider than the rules, so core answers the fixed messages.
const TITLE_TRANSPORT_MAX = 500;
const DESCRIPTION_TRANSPORT_MAX = 5000;
const CONTENT_TRANSPORT_MAX = 20000;
const DEFAULTS_TRANSPORT_KEYS = 40;

export const PromptVariableSchema = z.object({
  name: z.string().min(1).max(PROMPT_VARIABLE_NAME_MAX),
  defaultValue: z.string().max(PROMPT_VARIABLE_VALUE_MAX),
});

export const PromptVersionSchema = z.object({
  id: z.uuid(),
  number: z.number().int().min(1),
  content: z.string(),
  variables: z.array(PromptVariableSchema),
  createdAt: z.string(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  tags: z.array(TagAssignmentSchema),
  currentVersion: PromptVersionSchema,
  updatedAt: z.string(),
});
export type PromptSummary = z.infer<typeof PromptSummarySchema>;

/** Versions are newest first. */
export const PromptDetailSchema = PromptSummarySchema.extend({
  versions: z.array(PromptVersionSchema),
  createdAt: z.string(),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

/** Default values by variable name (matched regardless of case). */
export const PromptDefaultsSchema = z
  .record(z.string().max(200), z.string().max(PROMPT_VARIABLE_VALUE_MAX))
  .refine((defaults) => Object.keys(defaults).length <= DEFAULTS_TRANSPORT_KEYS);
export type PromptDefaults = z.infer<typeof PromptDefaultsSchema>;

export const ListPromptsSchema = z.object({
  query: z.string().max(200).optional(),
  tagNames: z.array(z.string().max(200)).max(20).optional(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(200),
});
export type ListPrompts = z.infer<typeof ListPromptsSchema>;

export const PromptPageSchema = z.object({
  items: z.array(PromptSummarySchema),
  total: z.number().int().min(0),
});
export type PromptPage = z.infer<typeof PromptPageSchema>;

export const CreatePromptSchema = z.object({
  title: z.string().max(TITLE_TRANSPORT_MAX),
  description: z.string().max(DESCRIPTION_TRANSPORT_MAX),
  content: z.string().max(CONTENT_TRANSPORT_MAX),
  defaults: PromptDefaultsSchema,
});
export type CreatePrompt = z.infer<typeof CreatePromptSchema>;

export const UpdatePromptSchema = z.object({
  promptId: z.uuid(),
  title: z.string().max(TITLE_TRANSPORT_MAX),
  description: z.string().max(DESCRIPTION_TRANSPORT_MAX),
});
export type UpdatePrompt = z.infer<typeof UpdatePromptSchema>;

export const SavePromptVersionSchema = z.object({
  promptId: z.uuid(),
  baseVersionId: z.uuid(),
  content: z.string().max(CONTENT_TRANSPORT_MAX),
  defaults: PromptDefaultsSchema,
});
export type SavePromptVersion = z.infer<typeof SavePromptVersionSchema>;
