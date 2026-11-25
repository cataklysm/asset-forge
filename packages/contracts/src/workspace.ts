import { z } from 'zod';

export const WORKSPACE_FORMAT_VERSION = 1;

export const WorkspaceManifestSchema = z.object({
  id: z.uuid(),
  formatVersion: z.number().int().min(1),
  name: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const WorkspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rootPath: z.string(),
  lastOpenedAt: z.iso.datetime(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
