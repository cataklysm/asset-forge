import { z } from 'zod';
import { ChangesSchema } from './changes';
import type { ChannelContracts } from './ipc-shared';

/** The change feed channel that lists read to update loaded rows in place. */
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
