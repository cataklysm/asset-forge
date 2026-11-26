import { z } from 'zod';
import { JobErrorCodeSchema, ModelNameSchema } from './jobs';

export const VISION_TIMEOUT_MIN_SECONDS = 10;
export const VISION_TIMEOUT_MAX_SECONDS = 600;
export const VISION_TIMEOUT_DEFAULT_SECONDS = 120;

const TimeoutSecondsSchema = z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS);
/** The base URL as entered; the host validates it (http or https, no user info, query or fragment). */
const BaseUrlSchema = z.string().max(2000).nullable();

/** The vision provider settings in force. Never carries the API key, only whether one is stored. */
export const VisionSettingsViewSchema = z.object({
  baseUrl: z.string().nullable(),
  timeoutSeconds: TimeoutSecondsSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
  hasApiKey: z.boolean(),
  /** The environment overrides the stored settings; they cannot be changed in the app. */
  fromEnvironment: z.boolean(),
  /** The OS credential store can encrypt; without it no key can be saved. */
  canStoreKey: z.boolean(),
});
export type VisionSettingsView = z.infer<typeof VisionSettingsViewSchema>;

/** `apiKey` absent: keep the stored key; `null`: delete it; a string: replace it. */
export const SetVisionSettingsSchema = z.object({
  baseUrl: BaseUrlSchema,
  timeoutSeconds: TimeoutSecondsSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
  apiKey: z.string().min(1).max(500).nullable().optional(),
});
export type SetVisionSettings = z.infer<typeof SetVisionSettingsSchema>;

/** A model of the provider; `vision` is null when the server does not report capabilities. */
export const VisionModelSchema = z.object({ name: ModelNameSchema, vision: z.boolean().nullable() });
export type VisionModel = z.infer<typeof VisionModelSchema>;

export const ListModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(VisionModelSchema) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
export type ListModelsResult = z.infer<typeof ListModelsResultSchema>;
