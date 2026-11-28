import { z } from 'zod';
import { IpcErrorSchema } from './errors';
import { FileRoleSchema } from './library';
import { TagAssignmentSchema } from './tags';
import { CountSchema, IdSchema } from './ipc-shared';
import { pageOf } from './paging';

/** `pending` while the import runs or awaits recovery, `complete` once committed, `failed` with `error` set. */
export const ImportStatusSchema = z.enum(['pending', 'complete', 'failed']);
/** The import state of a file row. */
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

/** The stored kind of a file, derived from its extension. */
export const FileKindSchema = z.enum(['image', 'model', 'document', 'video', 'other']);
/** The stored kind of a file. */
export type FileKind = z.infer<typeof FileKindSchema>;

/** A file row as the renderer sees it. `relativePath` is relative to the storage named by `storageId`. */
export const FileRecordSchema = z.object({
  id: IdSchema,
  storageId: IdSchema,
  assetId: IdSchema.nullable(),
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
  /** A raster image Sharp reads (thumbnails, viewer, analysis, studio input). */
  previewable: z.boolean(),
  /** A thumbnail can be asked for: a previewable image or a video (from one of its frames). */
  thumbnail: z.boolean(),
  /** The file may be handed to another program (`files:openExternal`). */
  openable: z.boolean(),
  kind: FileKindSchema,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** The length of a video in milliseconds, once measured; null otherwise. */
  durationMs: z.number().int().positive().nullable(),
  /** The tags of the file itself, never those of its asset. */
  tags: z.array(TagAssignmentSchema),
  /** A tag proposal of an analysis waits for the owner's decision. */
  hasProposal: z.boolean(),
  /** When the file was moved to the trash; null while it is not in the trash. */
  deletedAt: z.string().nullable(),
  /** The asset a trashed file came from (null for an inbox file, or when that asset is gone). */
  trashedAssetId: IdSchema.nullable(),
  trashedAssetName: z.string().nullable(),
  /** The role a trashed file had in that asset. */
  trashedRole: FileRoleSchema.nullable(),
});
/** A file row as the renderer sees it. */
export type FileRecord = z.infer<typeof FileRecordSchema>;

/**
 * One result per plain source; for an unpacked archive one per imported or refused entry, or one for the archive
 * as a whole.
 */
export const ImportResultSchema = z.object({
  sourcePath: z.string(),
  /** The entry's path inside the archive; null for a plain source and for an archive-level failure. */
  entryName: z.string().nullable(),
  file: FileRecordSchema.nullable(),
  error: z.string().nullable(),
  duplicateOf: z.array(IdSchema),
});
/** One result of `files:import`. */
export type ImportResult = z.infer<typeof ImportResultSchema>;

/**
 * The progress of the running `files:import`: items done out of the known total (an unpacked archive counts its
 * entries once its directory is read), and the bytes written of the item in progress, with its size when known.
 */
export const ImportProgressSchema = z.object({
  done: CountSchema,
  total: CountSchema,
  currentBytes: z.number().int().nonnegative(),
  currentSize: z.number().int().nonnegative().nullable(),
  cancelling: z.boolean(),
});
/** The progress of the running `files:import`. */
export type ImportProgress = z.infer<typeof ImportProgressSchema>;

/** Which files a list covers: every file, the unassigned inbox, the files of one asset, or the trash. */
export const FileScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('inbox') }),
  z.object({ kind: z.literal('asset'), assetId: IdSchema }),
  z.object({ kind: z.literal('trash') }),
]);
/** Which files a list covers. */
export type FileScope = z.infer<typeof FileScopeSchema>;

/** Where a file is placed: an asset and the role the file plays for it. */
export const FileTargetSchema = z.object({ assetId: IdSchema, role: FileRoleSchema });
/** Where a file is placed. */
export type FileTarget = z.infer<typeof FileTargetSchema>;

/** One page of a file list and the number of files the whole list holds. */
export const FileListSchema = pageOf(FileRecordSchema);
/** One page of a file list. */
export type FileList = z.infer<typeof FileListSchema>;

/** The files of a batch: 1 to 1000 distinct ids. */
export const FileIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'The file ids must be distinct' });

/**
 * One result per requested file, in request order: the resulting record or the error of that file.
 * A purged file, and a failed file removed outright, has neither (`file: null, error: null`).
 */
export const FileBatchResultSchema = z.object({
  items: z.array(
    z.object({
      fileId: IdSchema,
      file: FileRecordSchema.nullable(),
      error: IpcErrorSchema.nullable(),
    }),
  ),
});
/** The answer of a per-item file batch. */
export type FileBatchResult = z.infer<typeof FileBatchResultSchema>;

/** The outcome of emptying the trash. */
export const EmptyTrashResultSchema = z.object({
  purged: CountSchema,
  failed: CountSchema,
});
/** The answer of `trash:empty`. */
export type EmptyTrashResult = z.infer<typeof EmptyTrashResultSchema>;

/** The number of files in the trash. */
export const TrashSummarySchema = z.object({ count: CountSchema });
/** The answer of `trash:summary`. */
export type TrashSummary = z.infer<typeof TrashSummarySchema>;

/** The records an all-or-nothing tag batch answers; not a list page, so without a total. */
export const FileRecordsSchema = z.object({ items: z.array(FileRecordSchema) });
/** The records an all-or-nothing tag batch answers. */
export type FileRecords = z.infer<typeof FileRecordsSchema>;
