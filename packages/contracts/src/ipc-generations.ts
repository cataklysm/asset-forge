import { z } from 'zod';
import {
  GenerationSchema,
  MAX_FILE_GENERATIONS,
  MAX_RECENT_PROMPTS,
  StartGenerationResultSchema,
  StartGenerationSchema,
} from './generations';
import { type ChannelContracts, EmptyRequestSchema, IdSchema } from './ipc-shared';

export const generationChannels = {
  /** Starts an edit or upscale of one complete image outside the trash as a job. */
  'generations:start': {
    request: StartGenerationSchema,
    response: StartGenerationResultSchema,
  },
  /** The generation that made this file, and the generations made from it, newest first. */
  'generations:forFile': {
    request: z.object({ fileId: IdSchema }),
    response: z.object({
      madeBy: GenerationSchema.nullable(),
      results: z.array(GenerationSchema).max(MAX_FILE_GENERATIONS),
    }),
  },
  /** Only a failed or cancelled generation; it runs again with the same settings. */
  'generations:retry': {
    request: z.object({ generationId: IdSchema }),
    response: GenerationSchema,
  },
  /** Only a failed or cancelled generation. */
  'generations:remove': {
    request: z.object({ generationId: IdSchema }),
    response: z.object({}),
  },
  /** Distinct edit prompts, newest use first. */
  'generations:recentPrompts': {
    request: EmptyRequestSchema,
    response: z.object({ prompts: z.array(z.string()).max(MAX_RECENT_PROMPTS) }),
  },
} as const satisfies ChannelContracts;
