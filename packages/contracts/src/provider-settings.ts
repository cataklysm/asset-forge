import { z } from 'zod';
import { PROVIDER_EXTRA_MAX } from './extra-parameters';
import {
  MAX_PROVIDERS,
  ModelNameSchema,
  ProviderIdSchema,
  ProviderKindSchema,
  ProviderNameSchema,
} from './provider-ref';

/** Shortest request timeout of a provider entry, in seconds. */
export const VISION_TIMEOUT_MIN_SECONDS = 10;
/** Longest request timeout of a provider entry, in seconds. */
export const VISION_TIMEOUT_MAX_SECONDS = 600;
/** The request timeout a new provider entry starts with, in seconds. */
export const VISION_TIMEOUT_DEFAULT_SECONDS = 120;

const TimeoutSecondsSchema = z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS);

/** Whether a vision request asks the model to think; `default` sends nothing about it. */
export const ThinkingSchema = z.enum(['default', 'off', 'on']);
/** Whether a vision request asks the model to think. */
export type Thinking = z.infer<typeof ThinkingSchema>;

/** Analysis requests a vision entry gets at the same time: the fewest. */
export const PARALLEL_REQUESTS_MIN = 1;
/** Analysis requests a vision entry gets at the same time: the most. */
export const PARALLEL_REQUESTS_MAX = 64;
/** Analysis requests a vision entry gets at the same time: the value of a new entry. */
export const PARALLEL_REQUESTS_DEFAULT = 1;

/** The analysis requests a vision entry gets at the same time: 1 to 64. */
export const ParallelRequestsSchema = z.number().int().min(PARALLEL_REQUESTS_MIN).max(PARALLEL_REQUESTS_MAX);

/**
 * The request options of a vision entry. `maxTokens` null is not sent; `extra` is the JSON text as
 * typed, empty or a JSON object (see `parseExtraParameters`). `parallelRequests` bounds the analysis jobs of the
 * entry that run at once; it is never part of a request.
 */
export const ProviderOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),
  thinking: ThinkingSchema,
  maxTokens: z.number().int().min(1).max(100_000).nullable(),
  extra: z.string().max(PROVIDER_EXTRA_MAX),
  parallelRequests: ParallelRequestsSchema,
});
/** The request options of a vision entry. */
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

/** The options a new vision entry starts with; with them the `ollama` request body is unchanged. */
export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions = Object.freeze({
  temperature: 0,
  thinking: 'default',
  maxTokens: null,
  extra: '',
  parallelRequests: PARALLEL_REQUESTS_DEFAULT,
});

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
/** A provider entry as the renderer sees it. */
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** The answer of `providers:list`: every entry and the entries used last. */
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
/** The answer of `providers:list`. */
export type ProviderList = z.infer<typeof ProviderListSchema>;

/** The refusal of an API key that holds a control character or another character a request header cannot carry. */
export const API_KEY_CHARACTERS = 'The API key contains characters that cannot be sent';

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
  apiKey: z
    .string()
    .min(1)
    .max(500)
    // A key is sent in an HTTP header: printable Latin-1 only, so no control character and no line break.
    .regex(/^[\x20-\x7e\xa0-\xff]*$/, API_KEY_CHARACTERS)
    .nullable()
    .optional(),
  options: ProviderOptionsSchema.optional(),
});
/** The request of `providers:save`. */
export type SaveProvider = z.infer<typeof SaveProviderSchema>;
