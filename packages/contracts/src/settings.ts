import { z } from 'zod';
import { JobErrorCodeSchema, ModelNameSchema } from './jobs';
import { MAX_PROVIDERS, ProviderIdSchema, ProviderKindSchema, ProviderNameSchema } from './provider-ref';

export const VISION_TIMEOUT_MIN_SECONDS = 10;
export const VISION_TIMEOUT_MAX_SECONDS = 600;
export const VISION_TIMEOUT_DEFAULT_SECONDS = 120;

const TimeoutSecondsSchema = z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS);

/**
 * A provider entry. Never carries the API key, only whether one is stored. A `venice` view has
 * `taggingModel` and `promptModel` null; an `ollama` view has `editModel` null.
 */
export const ProviderViewSchema = z.object({
  id: ProviderIdSchema,
  kind: ProviderKindSchema,
  name: ProviderNameSchema,
  baseUrl: z.string(),
  timeoutSeconds: TimeoutSecondsSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
  editModel: ModelNameSchema.nullable(),
  hasApiKey: z.boolean(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

export const ProviderListSchema = z.object({
  providers: z.array(ProviderViewSchema).max(MAX_PROVIDERS),
  /** The entry used last for an analysis; null when none was used or it no longer exists. */
  lastUsedId: ProviderIdSchema.nullable(),
  /** The entry used last for a generation; null when none was used or it no longer exists. */
  lastUsedImageId: ProviderIdSchema.nullable(),
  /** The environment sets the only entry; entries cannot be changed in the app. */
  fromEnvironment: z.boolean(),
  /** The OS credential store can encrypt; without it no key can be saved. */
  canStoreKey: z.boolean(),
});
export type ProviderList = z.infer<typeof ProviderListSchema>;

/**
 * Without `id` a new entry is created; with `id` the entry is replaced. Name and base URL are only
 * bounded here; the host applies their rules (name 1 to 60 after trim, unique regardless of case;
 * http or https, no user info, query or fragment).
 * `apiKey` absent: keep the stored key; `null`: delete it; a string: replace it.
 * `kind` absent means `ollama` for a new entry; the kind of an existing entry cannot change.
 */
export const SaveProviderSchema = z.object({
  id: ProviderIdSchema.optional(),
  kind: ProviderKindSchema.optional(),
  name: z.string().max(200),
  baseUrl: z.string().max(2000),
  timeoutSeconds: TimeoutSecondsSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
  editModel: ModelNameSchema.nullable().optional(),
  apiKey: z.string().min(1).max(500).nullable().optional(),
});
export type SaveProvider = z.infer<typeof SaveProviderSchema>;

/** A model of the provider; `vision` is null when the server does not report capabilities. */
export const VisionModelSchema = z.object({ name: ModelNameSchema, vision: z.boolean().nullable() });
export type VisionModel = z.infer<typeof VisionModelSchema>;

export const ListModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(VisionModelSchema).max(100) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
export type ListModelsResult = z.infer<typeof ListModelsResultSchema>;

const ImageConstraintListSchema = z.array(z.string().min(1).max(20)).max(50).nullable();

/** An image edit model of a `venice` entry; a null constraint is one the provider does not report. */
export const ImageModelSchema = z.object({
  name: ModelNameSchema,
  aspectRatios: ImageConstraintListSchema,
  resolutions: ImageConstraintListSchema,
  defaultResolution: z.string().min(1).max(20).nullable(),
  promptCharacterLimit: z.number().int().positive().nullable(),
  price: z.string().max(200).nullable(),
});
export type ImageModel = z.infer<typeof ImageModelSchema>;

export const ListImageModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(ImageModelSchema).max(200) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
export type ListImageModelsResult = z.infer<typeof ListImageModelsResultSchema>;
