import { z } from 'zod';

/** The id of the read-only entry built from the environment at start. */
export const ENVIRONMENT_PROVIDER_ID = 'environment';
/** Longest provider name, after the trim. */
export const PROVIDER_NAME_MAX = 60;
/** Most provider entries at app level. */
export const MAX_PROVIDERS = 10;

/** A stored provider entry is named by a UUID; the environment entry by `environment`. */
export const ProviderIdSchema = z.union([z.uuid(), z.literal(ENVIRONMENT_PROVIDER_ID)]);
/** The id of a provider entry. */
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** The name of a provider entry: 1 to 60 characters after the trim. */
export const ProviderNameSchema = z.string().trim().min(1).max(PROVIDER_NAME_MAX);

/**
 * Entries of a `vision` kind (`ollama`, `openai`) analyse images; `venice` entries (purpose `image`)
 * edit and upscale them. A kind never changes.
 */
export const ProviderKindSchema = z.enum(['ollama', 'openai', 'venice']);
/** The adapter kind of a provider entry. */
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** What an entry is used for: `vision` analyses images, `image` generates them. */
export type ProviderPurpose = 'vision' | 'image';
/** The kinds of purpose `vision`. */
export type VisionKind = 'ollama' | 'openai';

/**
 * What an entry of a kind is used for.
 *
 * @param kind the kind of the entry
 * @returns `image` for `venice`, `vision` for every other kind
 */
export function purposeOf(kind: ProviderKind): ProviderPurpose {
  return kind === 'venice' ? 'image' : 'vision';
}

/**
 * Whether a kind analyses images.
 *
 * @param kind the kind of the entry
 * @returns true for the kinds of purpose `vision`
 */
export function isVisionKind(kind: ProviderKind): kind is VisionKind {
  return purposeOf(kind) === 'vision';
}

/** The base URL a new `venice` entry starts with. */
export const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

/** A model name as the provider lists it; stored and sent verbatim. */
export const ModelNameSchema = z.string().min(1).max(200);
