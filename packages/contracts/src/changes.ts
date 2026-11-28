import { z } from 'zod';

/**
 * What changed since a cursor of `changes:since`. `reset` is true for a null, foreign or too old cursor, and then
 * every list is empty and the caller treats everything as changed. `jobIds` and `fileIds` are distinct; `jobs` is
 * true when jobs were added, removed or changed in bulk; `added` names each place a file was added to once, with
 * `assetId` null for the inbox.
 */
export const ChangesSchema = z.object({
  cursor: z.string(),
  reset: z.boolean(),
  jobIds: z.array(z.string()),
  jobs: z.boolean(),
  fileIds: z.array(z.string()),
  added: z.array(z.object({ assetId: z.string().nullable() })),
});
/** The answer of `changes:since`. */
export type Changes = z.infer<typeof ChangesSchema>;
