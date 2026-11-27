import { z } from 'zod';
import { JobErrorCodeSchema, ModelNameSchema } from './jobs';
import { MAX_PROVIDERS, ProviderIdSchema, ProviderKindSchema, ProviderNameSchema, type VisionKind } from './provider-ref';

export const VISION_TIMEOUT_MIN_SECONDS = 10;
export const VISION_TIMEOUT_MAX_SECONDS = 600;
export const VISION_TIMEOUT_DEFAULT_SECONDS = 120;

const TimeoutSecondsSchema = z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS);

/** Whether a vision request asks the model to think; `default` sends nothing about it. */
export const ThinkingSchema = z.enum(['default', 'off', 'on']);
export type Thinking = z.infer<typeof ThinkingSchema>;

export const PROVIDER_EXTRA_MAX = 4000;

/**
 * The request options of a vision entry. `maxTokens` null is not sent; `extra` is the JSON text as
 * typed, empty or a JSON object (see `parseExtraParameters`).
 */
export const ProviderOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),
  thinking: ThinkingSchema,
  maxTokens: z.number().int().min(1).max(100_000).nullable(),
  extra: z.string().max(PROVIDER_EXTRA_MAX),
});
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions = Object.freeze({
  temperature: 0,
  thinking: 'default',
  maxTokens: null,
  extra: '',
});

/** Top-level keys the extra parameters must not set, because the adapter owns them. */
export const RESERVED_EXTRA_KEYS: Record<VisionKind, readonly string[]> = Object.freeze({
  ollama: Object.freeze(['model', 'messages', 'stream', 'format']),
  openai: Object.freeze(['model', 'messages', 'stream', 'response_format', 'n', 'tools', 'tool_choice']),
});

export type ExtraParameters =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'not_json' | 'not_object' }
  | { ok: false; reason: 'reserved'; key: string };

/**
 * Parses the extra parameters of a vision entry: empty or blank text is `{}`, otherwise the text
 * must be a JSON object without a top-level key reserved for the kind. Nested keys are not checked.
 */
export function parseExtraParameters(text: string, kind: VisionKind): ExtraParameters {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'not_object' };
  const value = parsed as Record<string, unknown>;
  const key = RESERVED_EXTRA_KEYS[kind].find((reserved) => Object.hasOwn(value, reserved));
  if (key !== undefined) return { ok: false, reason: 'reserved', key };
  return { ok: true, value };
}

/** The fixed message of a refused text. */
export function extraParametersMessage(refusal: Extract<ExtraParameters, { ok: false }>): string {
  return refusal.reason === 'reserved'
    ? `The extra parameters must not set ${refusal.key}`
    : 'The extra parameters are not a JSON object';
}

/** What an adapter is built with: the fixed fields and the parsed extra object. */
export interface VisionRequestOptions {
  temperature: number;
  thinking: Thinking;
  maxTokens: number | null;
  extra: Record<string, unknown>;
}

/**
 * A provider entry. Never carries the API key, only whether one is stored. A `venice` view has
 * `taggingModel` and `promptModel` null and `options` null; a vision view has `editModel` null.
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
  options: ProviderOptionsSchema.nullable(),
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
 * `options` absent keeps the stored options of an existing entry and gives a new entry the defaults;
 * they are ignored for `venice`.
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
  options: ProviderOptionsSchema.optional(),
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
