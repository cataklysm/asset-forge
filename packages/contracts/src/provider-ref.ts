import { z } from 'zod';

/** The id of the read-only entry built from the environment at start. */
export const ENVIRONMENT_PROVIDER_ID = 'environment';
export const PROVIDER_NAME_MAX = 60;
export const MAX_PROVIDERS = 10;

/** A stored provider entry is named by a UUID; the environment entry by `environment`. */
export const ProviderIdSchema = z.union([z.uuid(), z.literal(ENVIRONMENT_PROVIDER_ID)]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderNameSchema = z.string().trim().min(1).max(PROVIDER_NAME_MAX);

/**
 * Entries of a `vision` kind (`ollama`, `openai`) analyse images; `venice` entries (purpose `image`)
 * edit and upscale them. A kind never changes.
 */
export const ProviderKindSchema = z.enum(['ollama', 'openai', 'venice']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** What an entry is used for: `vision` analyses images, `image` generates them. */
export type ProviderPurpose = 'vision' | 'image';
export type VisionKind = 'ollama' | 'openai';

export function purposeOf(kind: ProviderKind): ProviderPurpose {
  return kind === 'venice' ? 'image' : 'vision';
}

export function isVisionKind(kind: ProviderKind): kind is VisionKind {
  return purposeOf(kind) === 'vision';
}

/** The base URL a new `venice` entry starts with. */
export const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

/** A model name as the provider lists it; stored and sent verbatim. */
export const ModelNameSchema = z.string().min(1).max(200);
