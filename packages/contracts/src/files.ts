import { z } from 'zod';
import { IpcErrorSchema } from './errors';
import { FileRoleSchema } from './library';
import { TagAssignmentSchema } from './tags';

export const ImportStatusSchema = z.enum(['pending', 'complete', 'failed']);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

export const FileKindSchema = z.enum(['image', 'model', 'document', 'other']);
export type FileKind = z.infer<typeof FileKindSchema>;

export const FileRecordSchema = z.object({
  id: z.uuid(),
  storageId: z.uuid(),
  assetId: z.uuid().nullable(),
  role: FileRoleSchema.nullable(),
  originalName: z.string(),
  relativePath: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0).nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  status: ImportStatusSchema,
  error: z.string().nullable(),
  importedAt: z.iso.datetime(),
  previewable: z.boolean(),
  openable: z.boolean(),
  kind: FileKindSchema,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  tags: z.array(TagAssignmentSchema), // file tags only
  /** A tag proposal of an analysis waits for the owner's decision. */
  hasProposal: z.boolean(),
  /** When the file was moved to the trash; null while it is not in the trash. */
  deletedAt: z.string().nullable(),
  /** The asset a trashed file came from (null for an inbox file, or when that asset is gone). */
  trashedAssetId: z.uuid().nullable(),
  trashedAssetName: z.string().nullable(),
  /** The role a trashed file had in that asset. */
  trashedRole: FileRoleSchema.nullable(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const ImportResultSchema = z.object({
  sourcePath: z.string(),
  file: FileRecordSchema.nullable(),
  error: z.string().nullable(),
  duplicateOf: z.array(z.uuid()),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

/** Which files a list covers: every file, the unassigned inbox, the files of one asset, or the trash. */
export const FileScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('inbox') }),
  z.object({ kind: z.literal('asset'), assetId: z.uuid() }),
  z.object({ kind: z.literal('trash') }),
]);
export type FileScope = z.infer<typeof FileScopeSchema>;

/** Where a file is placed: an asset and the role the file plays for it. */
export const FileTargetSchema = z.object({ assetId: z.uuid(), role: FileRoleSchema });
export type FileTarget = z.infer<typeof FileTargetSchema>;

export const FileListSchema = z.object({
  items: z.array(FileRecordSchema),
  total: z.number().int().min(0),
});
export type FileList = z.infer<typeof FileListSchema>;

/** The files of a batch: 1 to 1000 distinct ids. */
export const FileIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length, 'duplicate ids');

/**
 * One result per requested file, in request order: the resulting record or the error of that file.
 * A purged file, and a failed file removed outright, has neither (`file: null, error: null`).
 */
export const FileBatchResultSchema = z.object({
  items: z.array(
    z.object({
      fileId: z.uuid(),
      file: FileRecordSchema.nullable(),
      error: IpcErrorSchema.nullable(),
    }),
  ),
});
export type FileBatchResult = z.infer<typeof FileBatchResultSchema>;

/** The result of `files:assignMany`; the same shape as every per-item file batch. */
export const AssignManyResultSchema = FileBatchResultSchema;
export type AssignManyResult = FileBatchResult;

/** The outcome of emptying the trash. */
export const EmptyTrashResultSchema = z.object({
  purged: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type EmptyTrashResult = z.infer<typeof EmptyTrashResultSchema>;

/** The number of files in the trash. */
export const TrashSummarySchema = z.object({ count: z.number().int().min(0) });
export type TrashSummary = z.infer<typeof TrashSummarySchema>;

export const FileRecordsSchema = z.object({ items: z.array(FileRecordSchema) });
export type FileRecords = z.infer<typeof FileRecordsSchema>;
