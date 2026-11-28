import { z } from 'zod';
import { IdSchema } from './ipc-shared';

/** The format version a new workspace manifest is written with. */
export const WORKSPACE_FORMAT_VERSION = 1;

/** The manifest stored in a workspace's root directory. */
export const WorkspaceManifestSchema = z.object({
  id: IdSchema,
  formatVersion: z.number().int().min(1),
  name: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
});
/** The manifest stored in a workspace's root directory. */
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

/** A known workspace as the workspace list shows it. */
export const WorkspaceSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  rootPath: z.string(),
  lastOpenedAt: z.iso.datetime(),
});
/** A known workspace as the workspace list shows it. */
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
