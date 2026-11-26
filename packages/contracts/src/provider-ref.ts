import { z } from 'zod';

/** The id of the read-only entry built from the environment at start. */
export const ENVIRONMENT_PROVIDER_ID = 'environment';
export const PROVIDER_NAME_MAX = 60;
export const MAX_PROVIDERS = 10;

/** A stored provider entry is named by a UUID; the environment entry by `environment`. */
export const ProviderIdSchema = z.union([z.uuid(), z.literal(ENVIRONMENT_PROVIDER_ID)]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderNameSchema = z.string().trim().min(1).max(PROVIDER_NAME_MAX);

/** `ollama` entries analyse images (vision); `venice` entries edit and upscale them. A kind never changes. */
export const ProviderKindSchema = z.enum(['ollama', 'venice']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** The base URL a new `venice` entry starts with. */
export const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';
