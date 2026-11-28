import { z } from 'zod';
import { ChangesSchema } from './jobs';
import type { ChannelContracts } from './ipc-shared';

export const changeChannels = {
  /**
   * What changed in the open workspace since `cursor`; `reset` for a null, foreign or too old cursor and without a
   * workspace. Needs no workspace read and never waits for the queue.
   */
  'changes:since': {
    request: z.object({ cursor: z.string().max(100).nullable() }),
    response: ChangesSchema,
  },
} as const satisfies ChannelContracts;
