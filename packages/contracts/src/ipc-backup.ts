import { z } from 'zod';
import { BackupAttemptSchema, BackupStateSchema, BackupStatusSchema } from './backup';
import { type ChannelContracts, IdSchema } from './ipc-shared';

// The request schemas are strict: the renderer never sends a path, so an unknown field is refused, not dropped.

/** A backup channel request that takes nothing. */
const NoArgumentsSchema = z.object({}).strict();

/** The backup channels of the open workspace; `backup:state` also works without one. */
export const backupChannels = {
  /** The open workspace, whether a backup runs and the last attempt; `workspaceId: null` without a workspace. */
  'backup:state': {
    request: NoArgumentsSchema,
    response: BackupStateSchema,
  },
  /** The backup section of the settings; needs an open workspace. */
  'backup:status': {
    request: NoArgumentsSchema,
    response: BackupStatusSchema,
  },
  /** Lets the user pick a backup folder in a native dialog; null when the pick was cancelled. */
  'backup:changeLocation': {
    request: NoArgumentsSchema,
    response: BackupStatusSchema.nullable(),
  },
  /** Returns to the default place in the workspace folder. */
  'backup:resetLocation': {
    request: NoArgumentsSchema,
    response: BackupStatusSchema,
  },
  /** Backs the open workspace up now, changed or not. */
  'backup:now': {
    request: NoArgumentsSchema,
    response: BackupAttemptSchema,
  },
  /** Deletes a copy of another lineage, named by an id of the latest `backup:status`. */
  'backup:delete': {
    request: z.object({ backupId: IdSchema }).strict(),
    response: BackupStatusSchema,
  },
} as const satisfies ChannelContracts;
