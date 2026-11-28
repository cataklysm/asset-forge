import { z } from 'zod';
import { JobErrorCodeSchema } from './job-errors';
import { JobStatusSchema } from './jobs';
import { ModelNameSchema, ProviderIdSchema, ProviderKindSchema } from './provider-ref';
import { IdSchema } from './ipc-shared';

/** The host's limit on an edit prompt; a model may allow fewer characters. */
export const GENERATION_PROMPT_MAX = 8000;
/** The fewest pixels of a generation input. */
export const IMAGE_INPUT_MIN_PIXELS = 65_536;
/** The most pixels of a generation input. */
export const IMAGE_INPUT_MAX_PIXELS = 33_177_600;
/** The largest image sent to a provider, original or lossless rendition. */
export const IMAGE_INPUT_MAX_BYTES = 25_000_000;
/** The largest image answer read from a provider. */
export const IMAGE_ANSWER_MAX_BYTES = 100 * 1024 ** 2;
/** Equals `DEFAULT_LIMITS.maxPixels` in `packages/media/src/generate.ts`. */
export const UPSCALE_MAX_PIXELS = 100_000_000;
/** How many prompts `generations:recentPrompts` answers at most. */
export const MAX_RECENT_PROMPTS = 20;
/** How many generations `generations:forFile` answers at most per direction. */
export const MAX_FILE_GENERATIONS = 200;

/** An edit of one image or an upscale. */
export const GenerationKindSchema = z.enum(['edit', 'upscale']);
/** An edit of one image or an upscale. */
export type GenerationKind = z.infer<typeof GenerationKindSchema>;

/** The generation's own status; the technical job status is separate (`Generation.jobStatus`). */
export const GenerationStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'cancelled']);
/** The generation's own status. */
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

/** The factor of an upscale. */
export const UpscaleScaleSchema = z.union([z.literal(2), z.literal(4)]);
/** The factor of an upscale. */
export type UpscaleScale = z.infer<typeof UpscaleScaleSchema>;

/** The effective parameters of an edit; null aspect ratio or resolution leaves the model's default. */
export const EditParametersSchema = z.object({
  v: z.literal(1),
  aspectRatio: z.string().nullable(),
  resolution: z.string().nullable(),
  safeMode: z.boolean(),
});
/** The effective parameters of an edit. */
export type EditParameters = z.infer<typeof EditParametersSchema>;

/** The effective parameters of an upscale. */
export const UpscaleParametersSchema = z.object({ v: z.literal(1), scale: UpscaleScaleSchema });
/** The effective parameters of an upscale. */
export type UpscaleParameters = z.infer<typeof UpscaleParametersSchema>;

/** The versioned parameters a generation stores, of an edit or an upscale. */
export const GenerationParametersSchema = z.union([EditParametersSchema, UpscaleParametersSchema]);
/** The versioned parameters a generation stores. */
export type GenerationParameters = z.infer<typeof GenerationParametersSchema>;

/**
 * An input or output file of a generation; `fileId` null once the file was purged, `trashed` while it is in the
 * trash.
 */
export const GenerationFileSchema = z.object({
  fileId: IdSchema.nullable(),
  name: z.string(),
  sha256: z.string(),
  trashed: z.boolean(),
});
/** An input or output file of a generation. */
export type GenerationFile = z.infer<typeof GenerationFileSchema>;

/** A generation record: what was asked of which provider, with which inputs, and what came of it. */
export const GenerationSchema = z.object({
  id: IdSchema,
  kind: GenerationKindSchema,
  status: GenerationStatusSchema,
  errorCode: JobErrorCodeSchema.nullable(),
  providerId: ProviderIdSchema,
  /** A copy of the provider name taken at start. */
  providerName: z.string(),
  providerKind: ProviderKindSchema,
  /** Null for an upscale. */
  model: ModelNameSchema.nullable(),
  /** The fully resolved prompt; null for an upscale. */
  prompt: z.string().nullable(),
  parameters: GenerationParametersSchema,
  jobId: z.uuid().nullable(),
  /** The status of the current job; null when the job row is gone. */
  jobStatus: JobStatusSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  inputs: z.array(GenerationFileSchema),
  outputs: z.array(GenerationFileSchema),
  /** The library prompt of the version, read through the version row; null once the prompt is deleted. */
  promptId: z.uuid().nullable(),
  /** The library prompt version it was started from; null for an upscale, a free prompt or a deleted prompt. */
  promptVersionId: z.uuid().nullable(),
  /** Copies taken at start; they outlive the prompt. */
  promptTitle: z.string().nullable(),
  promptVersionNumber: z.number().int().min(1).nullable(),
  /** The values of the version's variables, by the version's spelling. */
  promptVariables: z.record(z.string(), z.string()).nullable(),
});
/** A generation record. */
export type Generation = z.infer<typeof GenerationSchema>;

/** The most variable values a start carries; core refuses names the version does not hold. */
const START_VARIABLES_TRANSPORT_KEYS = 40;

/**
 * Without `providerId` the image provider used last runs, otherwise the first one. An edit carries either a
 * free `prompt` or a library `promptVersionId` with the `variables` to fill in, never both. The prompt is only
 * bounded here; the host resolves a version and applies its rule (1 to 8000 characters after trim, and the
 * model's limit).
 */
export const StartGenerationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('edit'),
      fileId: IdSchema,
      providerId: ProviderIdSchema.optional(),
      model: ModelNameSchema,
      prompt: z.string().max(20000).optional(),
      promptVersionId: z.uuid().optional(),
      variables: z
        .record(z.string().max(200), z.string().max(20000))
        .refine((values) => Object.keys(values).length <= START_VARIABLES_TRANSPORT_KEYS)
        .optional(),
      aspectRatio: z.string().min(1).max(20).optional(),
      resolution: z.string().min(1).max(20).optional(),
      safeMode: z.boolean(),
    })
    .refine(
      (edit) =>
        (edit.prompt === undefined) !== (edit.promptVersionId === undefined) &&
        (edit.variables === undefined) === (edit.promptVersionId === undefined),
    ),
  z.object({
    kind: z.literal('upscale'),
    fileId: IdSchema,
    providerId: ProviderIdSchema.optional(),
    scale: UpscaleScaleSchema,
  }),
]);
/** The request of `generations:start`. */
export type StartGeneration = z.infer<typeof StartGenerationSchema>;

/** A provider that cannot list its models is a result, not an error; validation refusals stay errors. */
export const StartGenerationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), generation: GenerationSchema }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
/** The answer of `generations:start`. */
export type StartGenerationResult = z.infer<typeof StartGenerationResultSchema>;
