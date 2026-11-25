import { z } from 'zod';
import { FileRoleSchema } from './library';

export const ImportStatusSchema = z.enum(['pending', 'complete', 'failed']);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

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
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const ImportResultSchema = z.object({
  sourcePath: z.string(),
  file: FileRecordSchema.nullable(),
  error: z.string().nullable(),
  duplicateOf: z.array(z.uuid()),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const FileListSchema = z.object({
  items: z.array(FileRecordSchema),
  total: z.number().int().min(0),
});
export type FileList = z.infer<typeof FileListSchema>;
