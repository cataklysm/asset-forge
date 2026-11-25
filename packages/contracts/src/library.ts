import { z } from 'zod';
import { MatchedTagSchema, TagAssignmentSchema } from './tags';
import { WorkflowProgressSchema } from './workflows';

const id = z.uuid();
const timestamp = z.iso.datetime();
const count = z.number().int().min(0);

// Vocabularies

export const AssetStatusSchema = z.enum([
  'draft',
  'in_progress',
  'in_review',
  'completed',
  'archived',
]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const ProjectStatusSchema = z.enum(['active', 'on_hold', 'completed', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const FileRoleSchema = z.enum([
  'reference',
  'concept',
  'generated',
  'working',
  'model',
  'texture',
  'final',
  'other',
]);
export type FileRole = z.infer<typeof FileRoleSchema>;

export const RelationKindSchema = z.enum(['uses', 'variant_of', 'part_of', 'derived_from']);
export type RelationKind = z.infer<typeof RelationKindSchema>;

export const AssignmentPrioritySchema = z.enum(['low', 'normal', 'high']);
export type AssignmentPriority = z.infer<typeof AssignmentPrioritySchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// Input building blocks

export const NameInputSchema = z.string().trim().min(1).max(200);
export type NameInput = z.infer<typeof NameInputSchema>;
export const DescriptionInputSchema = z.string().max(5000);
export type DescriptionInput = z.infer<typeof DescriptionInputSchema>;
export const NotesInputSchema = z.string().max(5000);
export type NotesInput = z.infer<typeof NotesInputSchema>;
export const IntendedUseInputSchema = z.string().max(500);
export type IntendedUseInput = z.infer<typeof IntendedUseInputSchema>;

export const PageRequestSchema = z.object({
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().min(0),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: count });

// Entities

export const AssetTypeSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  builtIn: z.boolean(),
  defaultWorkflowTemplateId: id.nullable(),
});
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const ProjectSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  status: ProjectStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSummarySchema = ProjectSchema.extend({ assetCount: count });
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const AssetSchema = z.object({
  id,
  name: z.string(),
  typeId: id,
  description: z.string(),
  status: AssetStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetSummarySchema = AssetSchema.extend({
  projectCount: count,
  fileCount: count,
  workflowProgress: WorkflowProgressSchema.nullable(), // null when the asset has no workflow
  coverFileId: id.nullable(), // effective cover: the chosen one, else the first previewable image
  tags: z.array(TagAssignmentSchema), // asset tags only
  coverTags: z.array(TagAssignmentSchema), // tags of the effective cover file; empty without a cover
  matchedTags: z.array(MatchedTagSchema).optional(), // one per requested filter tag; only when the list filtered by tags
});
export type AssetSummary = z.infer<typeof AssetSummarySchema>;

export const AssetDetailSchema = AssetSchema.extend({
  coverFileId: id.nullable(), // effective cover, as in AssetSummary
  coverIsChosen: z.boolean(), // false when the cover is the automatic one or there is none
  tags: z.array(TagAssignmentSchema), // asset tags only; file tags are on the file records
});
export type AssetDetail = z.infer<typeof AssetDetailSchema>;

/** `fileId: null` returns to the automatic cover. */
export const SetCoverRequestSchema = z.object({ assetId: id, fileId: id.nullable() });
export type SetCoverRequest = z.infer<typeof SetCoverRequestSchema>;

export const ProjectAssignmentSchema = z.object({
  projectId: id,
  assetId: id,
  priority: AssignmentPrioritySchema,
  intendedUse: z.string(),
  approvalStatus: ApprovalStatusSchema,
  notes: z.string(),
  assignedAt: timestamp,
  updatedAt: timestamp,
});
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

/** An assignment seen from the asset. */
export const AssetAssignmentSchema = ProjectAssignmentSchema.extend({ project: ProjectSchema });
export type AssetAssignment = z.infer<typeof AssetAssignmentSchema>;

/** An assignment seen from the project. */
export const ProjectMemberSchema = ProjectAssignmentSchema.extend({ asset: AssetSchema });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const AssetRelationSchema = z.object({
  fromAssetId: id,
  toAssetId: id,
  kind: RelationKindSchema,
  createdAt: timestamp,
});
export type AssetRelation = z.infer<typeof AssetRelationSchema>;

export const AssetRelationViewSchema = AssetRelationSchema.extend({
  direction: z.enum(['outgoing', 'incoming']),
  other: AssetSchema,
});
export type AssetRelationView = z.infer<typeof AssetRelationViewSchema>;

export const ProjectListSchema = pageOf(ProjectSummarySchema);
export type ProjectList = z.infer<typeof ProjectListSchema>;
export const AssetListSchema = pageOf(AssetSummarySchema);
export type AssetList = z.infer<typeof AssetListSchema>;
export const ProjectMemberListSchema = pageOf(ProjectMemberSchema);
export type ProjectMemberList = z.infer<typeof ProjectMemberListSchema>;
