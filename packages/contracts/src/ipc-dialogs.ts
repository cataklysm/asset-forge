import { z } from 'zod';
import { type ChannelContracts, EmptyRequestSchema } from './ipc-shared';

export const dialogChannels = {
  'dialog:pickDirectory': {
    request: EmptyRequestSchema,
    response: z.string().nullable(),
  },
  'dialog:pickFiles': {
    request: EmptyRequestSchema,
    response: z.array(z.string()),
  },
} as const satisfies ChannelContracts;
