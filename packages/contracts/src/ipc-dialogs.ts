import { z } from 'zod';
import { type ChannelContracts, EmptyRequestSchema } from './ipc-shared';

/** The native dialogs of the main process that pick files or a directory. */
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
