import { z } from 'zod';
import { IdSchema } from './ipc-shared';

/** Longest name of an analysis prompt, after the trim. */
export const ANALYSIS_PROMPT_NAME_MAX = 60;
/** Longest text of an analysis prompt, after the trim. */
export const ANALYSIS_PROMPT_TEXT_MAX = 8000;
/** Fewest tags a tagging prompt may ask for. */
export const ANALYSIS_TAG_LIMIT_MIN = 1;
/** Most tags a tagging prompt may ask for. */
export const ANALYSIS_TAG_LIMIT_MAX = 50;
/** The tag limit of the built-in tagging prompt. */
export const ANALYSIS_TAG_LIMIT_DEFAULT = 15;
/** Most analysis prompts kept per purpose. */
export const ANALYSIS_PROMPTS_PER_PURPOSE = 50;

/** `tagging` drives the tag analysis, `image_prompt` the Image to prompt description. */
export const AnalysisPromptPurposeSchema = z.enum(['tagging', 'image_prompt']);
/** What an analysis prompt is used for. */
export type AnalysisPromptPurpose = z.infer<typeof AnalysisPromptPurposeSchema>;

/** The name of an analysis prompt: 1 to 60 characters after the trim. */
export const AnalysisPromptNameSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_NAME_MAX);
/** The text of an analysis prompt: 1 to 8000 characters after the trim. */
export const AnalysisPromptTextSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_TEXT_MAX);
/** How many tags a tagging prompt asks for and the answer is cut at. */
export const AnalysisTagLimitSchema = z.number().int().min(ANALYSIS_TAG_LIMIT_MIN).max(ANALYSIS_TAG_LIMIT_MAX);

/** Discriminated on `purpose`: only a tagging prompt has `maxTags`. */
export const AnalysisPromptSchema = z.discriminatedUnion('purpose', [
  z.object({
    id: IdSchema,
    purpose: z.literal('tagging'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
    maxTags: AnalysisTagLimitSchema,
  }),
  z.object({
    id: IdSchema,
    purpose: z.literal('image_prompt'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
  }),
]);
/** A stored analysis prompt. */
export type AnalysisPrompt = z.infer<typeof AnalysisPromptSchema>;

/** The same two shapes as `AnalysisPromptSchema`; without an id the prompt is created. */
export const SaveAnalysisPromptSchema = z.discriminatedUnion('purpose', [
  z.object({
    id: IdSchema.optional(),
    purpose: z.literal('tagging'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
    maxTags: AnalysisTagLimitSchema,
  }),
  z.object({
    id: IdSchema.optional(),
    purpose: z.literal('image_prompt'),
    name: AnalysisPromptNameSchema,
    text: AnalysisPromptTextSchema,
  }),
]);
/** The request of `analysisPrompts:save`. */
export type SaveAnalysisPrompt = z.infer<typeof SaveAnalysisPromptSchema>;

/** All analysis prompts and, per purpose, the id of the one used last (null when none was used yet). */
export const AnalysisPromptListSchema = z.object({
  prompts: z.array(AnalysisPromptSchema),
  lastUsed: z.object({ tagging: IdSchema.nullable(), imagePrompt: IdSchema.nullable() }),
});
/** The answer of `analysisPrompts:list`. */
export type AnalysisPromptList = z.infer<typeof AnalysisPromptListSchema>;
