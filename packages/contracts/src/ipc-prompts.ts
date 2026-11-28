import { z } from 'zod';
import {
  CreatePromptSchema,
  ListPromptsSchema,
  PromptDetailSchema,
  PromptPageSchema,
  SavePromptVersionSchema,
  UpdatePromptSchema,
} from './prompts';
import { type ChannelContracts, IdSchema } from './ipc-shared';

/** The prompt library channels: prompts of the workspace with their versions and tags. */
export const promptChannels = {
  /** The prompt library, newest change first; every query word must appear, every tag must be on the prompt. */
  'prompts:list': {
    request: ListPromptsSchema,
    response: PromptPageSchema,
  },
  'prompts:get': {
    request: z.object({ promptId: IdSchema }),
    response: PromptDetailSchema,
  },
  /** A prompt with version 1; the title is unique regardless of case. */
  'prompts:create': {
    request: CreatePromptSchema,
    response: PromptDetailSchema,
  },
  /** Title and description only. */
  'prompts:update': {
    request: UpdatePromptSchema,
    response: PromptDetailSchema,
  },
  /** A new version on top of `baseVersionId`, which must be the current one; an unchanged text writes nothing. */
  'prompts:saveVersion': {
    request: SavePromptVersionSchema,
    response: PromptDetailSchema,
  },
  /** Generations keep their copies of the prompt. */
  'prompts:delete': {
    request: z.object({ promptId: IdSchema }),
    response: z.object({}),
  },
  'prompts:addTag': {
    request: z.object({ promptId: IdSchema, name: z.string().max(200) }),
    response: PromptDetailSchema,
  },
  /** A tag the prompt does not carry is a no-op. */
  'prompts:removeTag': {
    request: z.object({ promptId: IdSchema, name: z.string().max(200) }),
    response: PromptDetailSchema,
  },
} as const satisfies ChannelContracts;
