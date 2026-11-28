import { z } from 'zod';
import { pageOf } from './paging';
import { MatchedTagSchema, TagAssignmentSchema } from './tags';
import { WorkflowProgressSchema } from './workflows';

const id = z.uuid();
const timestamp = z.iso.datetime();
const count = z.number().int().min(0);

// Vocabularies

/** The status of an asset; separate from workflow step state and job status. */
export const AssetStatusSchema = z.enum(['draft', 'in_progress', 'in_review', 'completed', 'archived']);
/** The status of an asset. */
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

/** The status of a project. */
export const ProjectStatusSchema = z.enum(['active', 'on_hold', 'completed', 'archived']);
/** The status of a project. */
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** The role a file plays for its asset; independent of asset type and file kind. */
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
/** The role a file plays for its asset. */
export type FileRole = z.infer<typeof FileRoleSchema>;

/** The kind of a typed relation from one asset to another. */
export const RelationKindSchema = z.enum(['uses', 'variant_of', 'part_of', 'derived_from']);
/** The kind of a typed relation between assets. */
export type RelationKind = z.infer<typeof RelationKindSchema>;

/** The priority of an asset within one project. */
export const AssignmentPrioritySchema = z.enum(['low', 'normal', 'high']);
/** The priority of an asset within one project. */
export type AssignmentPriority = z.infer<typeof AssignmentPrioritySchema>;

/** The approval of an asset within one project. */
export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
/** The approval of an asset within one project. */
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// Input building blocks

/** The name of an asset or project: 1 to 200 characters after the trim. */
export const NameInputSchema = z.string().trim().min(1).max(200);
/** The name of an asset or project. */
export type NameInput = z.infer<typeof NameInputSchema>;
/** The description of an asset or project: at most 5000 characters. */
export const DescriptionInputSchema = z.string().max(5000);
/** The description of an asset or project. */
export type DescriptionInput = z.infer<typeof DescriptionInputSchema>;
/** The notes of an assignment: at most 5000 characters. */
export const NotesInputSchema = z.string().max(5000);
/** The notes of an assignment. */
export type NotesInput = z.infer<typeof NotesInputSchema>;
/** What an asset is meant for in a project: at most 500 characters. */
export const IntendedUseInputSchema = z.string().max(500);
/** What an asset is meant for in a project. */
export type IntendedUseInput = z.infer<typeof IntendedUseInputSchema>;

// Entities

/** An asset type with the default workflow template of its assets. */
export const AssetTypeSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  builtIn: z.boolean(),
  defaultWorkflowTemplateId: id.nullable(),
});
/** An asset type. */
export type AssetType = z.infer<typeof AssetTypeSchema>;

/** A project. */
export const ProjectSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  status: ProjectStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
/** A project. */
export type Project = z.infer<typeof ProjectSchema>;

/** A project as the project list shows it. */
export const ProjectSummarySchema = ProjectSchema.extend({
  assetCount: count,
  /** Complete image files over all member assets. */
  imageCount: count,
  /** One per requested filter tag, over the members that carry all of them; only when the list filtered by tags. */
  matchedTags: z.array(MatchedTagSchema).optional(),
});
/** A project as the project list shows it. */
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** An asset, the central object of the library. */
export const AssetSchema = z.object({
  id,
  name: z.string(),
  typeId: id,
  description: z.string(),
  status: AssetStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
/** An asset. */
export type Asset = z.infer<typeof AssetSchema>;

/** An asset as the gallery shows it. */
export const AssetSummarySchema = AssetSchema.extend({
  projectCount: count,
  fileCount: count,
  /** Null when the asset has no workflow. */
  workflowProgress: WorkflowProgressSchema.nullable(),
  /** The effective cover: the chosen one, else the first previewable image, else the first video. */
  coverFileId: id.nullable(),
  /** The tags of the asset itself. */
  tags: z.array(TagAssignmentSchema),
  /** The tags of the effective cover file; empty without a cover. */
  coverTags: z.array(TagAssignmentSchema),
  /** One per requested filter tag; only when the list filtered by tags. */
  matchedTags: z.array(MatchedTagSchema).optional(),
});
/** An asset as the gallery shows it. */
export type AssetSummary = z.infer<typeof AssetSummarySchema>;

/** A web address the asset's material came from; `url` is the normalised `href` (http or https only). */
export const AssetSourceSchema = z.object({
  id,
  url: z.string(),
  createdAt: timestamp,
});
/** A web address the asset's material came from. */
export type AssetSource = z.infer<typeof AssetSourceSchema>;

/** An asset as the asset screen shows it. */
export const AssetDetailSchema = AssetSchema.extend({
  /** The effective cover, as in `AssetSummary`. */
  coverFileId: id.nullable(),
  /** False when the cover is the automatic one or there is none. */
  coverIsChosen: z.boolean(),
  /** The tags of the asset itself; file tags are on the file records. */
  tags: z.array(TagAssignmentSchema),
  /** By `createdAt`, then `id`. */
  sources: z.array(AssetSourceSchema),
});
/** An asset as the asset screen shows it. */
export type AssetDetail = z.infer<typeof AssetDetailSchema>;

/** `fileId: null` returns to the automatic cover. */
export const SetCoverRequestSchema = z.object({ assetId: id, fileId: id.nullable() });
/** The request of `assets:setCover`. */
export type SetCoverRequest = z.infer<typeof SetCoverRequestSchema>;

/** The assignment of an asset to a project with its project-specific data. */
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
/** The assignment of an asset to a project. */
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

/** An assignment seen from the asset. */
export const AssetAssignmentSchema = ProjectAssignmentSchema.extend({ project: ProjectSchema });
/** An assignment seen from the asset. */
export type AssetAssignment = z.infer<typeof AssetAssignmentSchema>;

/** An assignment seen from the project. */
export const ProjectMemberSchema = ProjectAssignmentSchema.extend({ asset: AssetSchema });
/** An assignment seen from the project. */
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

/** A typed relation from one asset to another. */
export const AssetRelationSchema = z.object({
  fromAssetId: id,
  toAssetId: id,
  kind: RelationKindSchema,
  createdAt: timestamp,
});
/** A typed relation from one asset to another. */
export type AssetRelation = z.infer<typeof AssetRelationSchema>;

/** A relation seen from one asset: its direction and the asset at the other end. */
export const AssetRelationViewSchema = AssetRelationSchema.extend({
  direction: z.enum(['outgoing', 'incoming']),
  other: AssetSchema,
});
/** A relation seen from one asset. */
export type AssetRelationView = z.infer<typeof AssetRelationViewSchema>;

/** One page of the project list. */
export const ProjectListSchema = pageOf(ProjectSummarySchema);
/** One page of the project list. */
export type ProjectList = z.infer<typeof ProjectListSchema>;
/** One page of the gallery. */
export const AssetListSchema = pageOf(AssetSummarySchema);
/** One page of the gallery. */
export type AssetList = z.infer<typeof AssetListSchema>;
/** One page of the members of a project. */
export const ProjectMemberListSchema = pageOf(ProjectMemberSchema);
/** One page of the members of a project. */
export type ProjectMemberList = z.infer<typeof ProjectMemberListSchema>;
