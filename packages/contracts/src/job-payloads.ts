import { z } from 'zod';
import { AnalysisPromptNameSchema, AnalysisPromptTextSchema, AnalysisTagLimitSchema } from './analysis-prompts';
import { FileTargetSchema } from './files';
import { ModelNameSchema, ProviderNameSchema } from './provider-ref';
import { SiteFilterSchema } from './site-import';

export const ANALYZE_FILE_JOB = 'vision.analyze_file';
export const IMAGE_GENERATE_JOB = 'image.generate';
export const FILE_DOWNLOAD_JOB = 'file.download';

const downloadFields = {
  url: z.string().min(1).max(2000),
  target: FileTargetSchema.nullable(),
  skipDuplicates: z.boolean(),
};

/** A download job of the URL import; `target` null leaves the file in the inbox. */
export const FileDownloadPayloadV1Schema = z.object({ v: z.literal(1), ...downloadFields });
/** A download of the site import: sent with the profile's login, kept only when it passes `filter`. */
export const FileDownloadPayloadV2Schema = z.object({
  v: z.literal(2),
  ...downloadFields,
  siteProfileId: z.uuid(),
  filter: SiteFilterSchema,
});
export const FileDownloadPayloadSchema = z.discriminatedUnion('v', [FileDownloadPayloadV1Schema, FileDownloadPayloadV2Schema]);
export type FileDownloadPayload = z.infer<typeof FileDownloadPayloadSchema>;

/** { url, host } of a download payload; nulls for anything else. `host` is lower case with a non-default port. */
export function downloadJobFields(payload: unknown): { url: string | null; host: string | null } {
  const parsed = FileDownloadPayloadSchema.safeParse(payload);
  if (!parsed.success) return { url: null, host: null };
  try {
    return { url: parsed.data.url, host: new URL(parsed.data.url).host };
  } catch {
    return { url: null, host: null };
  }
}

/** An image generation job names its generation row; everything else lives on that row. */
export const ImageGeneratePayloadSchema = z.object({ v: z.literal(1), generationId: z.uuid() });
export type ImageGeneratePayload = z.infer<typeof ImageGeneratePayloadSchema>;

/** The analysis prompt a v3 job runs with, copied at enqueue so later edits do not reach waiting jobs. */
export const AnalyzeFilePromptSchema = z.object({
  name: AnalysisPromptNameSchema,
  text: AnalysisPromptTextSchema,
  maxTags: AnalysisTagLimitSchema,
});
export type AnalyzeFilePrompt = z.infer<typeof AnalyzeFilePromptSchema>;

/**
 * v1 rows were written by phase 4a and run in mode `apply` with the tagging default model;
 * v2 carries the model chosen at enqueue and whether the result is applied or proposed;
 * v3 adds the analysis prompt; v4 adds a copy of the provider name, and its prompt may be null.
 * v1 and v2 jobs run with the built-in prompt and at most 20 tags.
 */
export const AnalyzeFilePayloadSchema = z.union([
  z.object({ version: z.literal(1) }),
  z.object({ version: z.literal(2), model: ModelNameSchema, mode: z.enum(['apply', 'propose']) }),
  z.object({
    version: z.literal(3),
    model: ModelNameSchema,
    mode: z.enum(['apply', 'propose']),
    prompt: AnalyzeFilePromptSchema,
  }),
  z.object({
    version: z.literal(4),
    model: ModelNameSchema,
    mode: z.enum(['apply', 'propose']),
    prompt: AnalyzeFilePromptSchema.nullable(),
    providerName: ProviderNameSchema,
  }),
]);
export type AnalyzeFilePayload = z.infer<typeof AnalyzeFilePayloadSchema>;

/** The provider name (v4) and model (v2 to v4) of an analysis payload; nulls otherwise or when it does not parse. */
export function analysisJobFields(payload: unknown): { providerName: string | null; model: string | null } {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.version === 1) return { providerName: null, model: null };
  return { providerName: parsed.data.version === 4 ? parsed.data.providerName : null, model: parsed.data.model };
}
