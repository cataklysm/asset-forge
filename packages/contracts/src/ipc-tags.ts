import { z } from 'zod';
import { TagRenameResultSchema, TagSuggestionSchema, TagUsageSchema } from './tags';
import type { ChannelContracts } from './ipc-shared';

/** The tag channels: suggestions, usage counts and rename or merge across the workspace. */
export const tagChannels = {
  'tags:suggest': {
    request: z.object({ prefix: z.string().max(200), limit: z.number().int().min(1).max(50) }),
    response: z.array(TagSuggestionSchema),
  },
  /** Free text, normalised in main; a text that is no valid tag name answers `exists: false` with zero counts. */
  'tags:usage': {
    request: z.object({ name: z.string().max(200) }),
    response: TagUsageSchema,
  },
  /** Renames a tag workspace-wide; onto an existing other tag only with `merge: true`. */
  'tags:rename': {
    request: z.object({ from: z.string().max(200), to: z.string().max(200), merge: z.boolean() }),
    response: TagRenameResultSchema,
  },
} as const satisfies ChannelContracts;
