import { z } from 'zod';

export const ANALYSIS_PROMPT_NAME_MAX = 60;
export const ANALYSIS_PROMPT_TEXT_MAX = 8000;
export const ANALYSIS_TAG_LIMIT_MIN = 1;
export const ANALYSIS_TAG_LIMIT_MAX = 50;
export const ANALYSIS_TAG_LIMIT_DEFAULT = 15;
export const ANALYSIS_PROMPTS_PER_PURPOSE = 50;

/** `tagging` drives the tag analysis, `image_prompt` the Image to prompt description. */
export const AnalysisPromptPurposeSchema = z.enum(['tagging', 'image_prompt']);
export type AnalysisPromptPurpose = z.infer<typeof AnalysisPromptPurposeSchema>;

export const AnalysisPromptNameSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_NAME_MAX);
export const AnalysisPromptTextSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_TEXT_MAX);
export const AnalysisTagLimitSchema = z.number().int().min(ANALYSIS_TAG_LIMIT_MIN).max(ANALYSIS_TAG_LIMIT_MAX);

/** Discriminated on `purpose`: only a tagging prompt has `maxTags`. */
export const AnalysisPromptSchema = z.discriminatedUnion('purpose', [
  z.object({
    id: z.uuid(),
    purpose: z.literal('tagging'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
    maxTags: AnalysisTagLimitSchema,
  }),
  z.object({
    id: z.uuid(),
    purpose: z.literal('image_prompt'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
  }),
]);
export type AnalysisPrompt = z.infer<typeof AnalysisPromptSchema>;

/** The same two shapes as `AnalysisPromptSchema`; without an id the prompt is created. */
export const SaveAnalysisPromptSchema = z.discriminatedUnion('purpose', [
  z.object({
    id: z.uuid().optional(),
    purpose: z.literal('tagging'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
    maxTags: AnalysisTagLimitSchema,
  }),
  z.object({
    id: z.uuid().optional(),
    purpose: z.literal('image_prompt'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
  }),
]);
export type SaveAnalysisPrompt = z.infer<typeof SaveAnalysisPromptSchema>;

/** All analysis prompts and, per purpose, the id of the one used last (null when none was used yet). */
export const AnalysisPromptListSchema = z.object({
  prompts: z.array(AnalysisPromptSchema),
  lastUsed: z.object({ tagging: z.uuid().nullable(), imagePrompt: z.uuid().nullable() }),
});
export type AnalysisPromptList = z.infer<typeof AnalysisPromptListSchema>;
