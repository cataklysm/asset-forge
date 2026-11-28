import { z } from 'zod';
import { AnalysisPromptListSchema, AnalysisPromptSchema, SaveAnalysisPromptSchema } from './analysis-prompts';
import { type ChannelContracts, EmptyRequestSchema, IdRequestSchema } from './ipc-shared';

export const analysisPromptChannels = {
  /** App-level analysis prompts need no open workspace. The file order is kept; a purpose never has none. */
  'analysisPrompts:list': {
    request: EmptyRequestSchema,
    response: AnalysisPromptListSchema,
  },
  /** Without `id` the prompt is appended; with `id` it is replaced in place. The purpose cannot change. */
  'analysisPrompts:save': {
    request: SaveAnalysisPromptSchema,
    response: AnalysisPromptSchema,
  },
  /** Refused for the last prompt of a purpose; the prompt used last reads as null afterwards. */
  'analysisPrompts:delete': {
    request: IdRequestSchema,
    response: z.object({}),
  },
  /** Text (and tag limit) back to the built-in content of its purpose; the name stays. */
  'analysisPrompts:reset': {
    request: IdRequestSchema,
    response: AnalysisPromptSchema,
  },
} as const satisfies ChannelContracts;
