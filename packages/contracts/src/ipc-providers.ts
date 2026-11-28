import { z } from 'zod';
import { ListImageModelsResultSchema, ListModelsResultSchema } from './provider-models';
import { ProviderIdSchema } from './provider-ref';
import { ProviderListSchema, ProviderViewSchema, SaveProviderSchema } from './provider-settings';
import { type ChannelContracts, EmptyRequestSchema } from './ipc-shared';

/** The provider channels: the provider entries of the app and the models each one offers. */
export const providerChannels = {
  /** Provider channels need no open workspace. A view never carries an API key. */
  'providers:list': {
    request: EmptyRequestSchema,
    response: ProviderListSchema,
  },
  /**
   * Without `id` the entry is created, with `id` it is replaced. `apiKey` absent keeps the stored key,
   * `null` deletes it; a changed origin without a new key deletes it.
   */
  'providers:save': {
    request: SaveProviderSchema,
    response: ProviderViewSchema,
  },
  /** Refused while the entry has active jobs. */
  'providers:delete': {
    request: z.object({ id: ProviderIdSchema }),
    response: z.object({}),
  },
  /** The models of one entry; cached until the entry changes or `refresh` is true. */
  'providers:listModels': {
    request: z.object({ providerId: ProviderIdSchema, refresh: z.boolean().optional() }),
    response: ListModelsResultSchema,
  },
  /** The image edit models of a `venice` entry; cached until the entry changes or `refresh` is true. */
  'providers:listImageModels': {
    request: z.object({ providerId: ProviderIdSchema, refresh: z.boolean().optional() }),
    response: ListImageModelsResultSchema,
  },
} as const satisfies ChannelContracts;
