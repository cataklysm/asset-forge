import { z } from 'zod';
import { IdSchema } from './ipc-shared';
import { PageRequestSchema, pageOf } from './paging';
import { PROMPT_VARIABLE_NAME_MAX, PROMPT_VARIABLE_VALUE_MAX } from './prompt-template';
import { TagAssignmentSchema } from './tags';

/** Longest title of a library prompt. */
export const PROMPT_TITLE_MAX = 120;
/** Longest description of a library prompt. */
export const PROMPT_DESCRIPTION_MAX = 2000;
/** Most variables one prompt version may hold. */
export const MAX_PROMPT_VARIABLES = 20;
/** Most tags one library prompt may carry. */
export const MAX_PROMPT_TAGS = 50;

// Transport bounds are deliberately wider than the rules, so core answers the fixed messages.
const TITLE_TRANSPORT_MAX = 500;
const DESCRIPTION_TRANSPORT_MAX = 5000;
const CONTENT_TRANSPORT_MAX = 20000;
const DEFAULTS_TRANSPORT_KEYS = 40;

/** A variable of a prompt version with its default value. */
export const PromptVariableSchema = z.object({
  name: z.string().min(1).max(PROMPT_VARIABLE_NAME_MAX),
  defaultValue: z.string().max(PROMPT_VARIABLE_VALUE_MAX),
});

/** An immutable version of a library prompt; the current version is the highest number. */
export const PromptVersionSchema = z.object({
  id: IdSchema,
  number: z.number().int().min(1),
  content: z.string(),
  variables: z.array(PromptVariableSchema),
  createdAt: z.string(),
});
/** An immutable version of a library prompt. */
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

/** A library prompt as the prompt list shows it, with its current version. */
export const PromptSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(TagAssignmentSchema),
  currentVersion: PromptVersionSchema,
  updatedAt: z.string(),
});
/** A library prompt as the prompt list shows it. */
export type PromptSummary = z.infer<typeof PromptSummarySchema>;

/** Versions are newest first. */
export const PromptDetailSchema = PromptSummarySchema.extend({
  versions: z.array(PromptVersionSchema),
  createdAt: z.string(),
});
/** A library prompt with all its versions. */
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

/** Default values by variable name (matched regardless of case). */
export const PromptDefaultsSchema = z
  .record(z.string().max(200), z.string().max(PROMPT_VARIABLE_VALUE_MAX))
  .refine((defaults) => Object.keys(defaults).length <= DEFAULTS_TRANSPORT_KEYS);
/** Default values by variable name. */
export type PromptDefaults = z.infer<typeof PromptDefaultsSchema>;

/** The request of `prompts:list`: search words, tags that must all be present, and the page. */
export const ListPromptsSchema = PageRequestSchema.extend({
  query: z.string().max(200).optional(),
  tagNames: z.array(z.string().max(200)).max(20).optional(),
});
/** The request of `prompts:list`. */
export type ListPrompts = z.infer<typeof ListPromptsSchema>;

/** One page of the prompt list and the number of prompts the whole list holds. */
export const PromptPageSchema = pageOf(PromptSummarySchema);
/** One page of the prompt list. */
export type PromptPage = z.infer<typeof PromptPageSchema>;

/** The request of `prompts:create`: the prompt and its first version. */
export const CreatePromptSchema = z.object({
  title: z.string().max(TITLE_TRANSPORT_MAX),
  description: z.string().max(DESCRIPTION_TRANSPORT_MAX),
  content: z.string().max(CONTENT_TRANSPORT_MAX),
  defaults: PromptDefaultsSchema,
});
/** The request of `prompts:create`. */
export type CreatePrompt = z.infer<typeof CreatePromptSchema>;

/** The request of `prompts:update`: title and description only, which are not versioned. */
export const UpdatePromptSchema = z.object({
  promptId: IdSchema,
  title: z.string().max(TITLE_TRANSPORT_MAX),
  description: z.string().max(DESCRIPTION_TRANSPORT_MAX),
});
/** The request of `prompts:update`. */
export type UpdatePrompt = z.infer<typeof UpdatePromptSchema>;

/** The request of `prompts:saveVersion`; `baseVersionId` must be the current version. */
export const SavePromptVersionSchema = z.object({
  promptId: IdSchema,
  baseVersionId: IdSchema,
  content: z.string().max(CONTENT_TRANSPORT_MAX),
  defaults: PromptDefaultsSchema,
});
/** The request of `prompts:saveVersion`. */
export type SavePromptVersion = z.infer<typeof SavePromptVersionSchema>;
