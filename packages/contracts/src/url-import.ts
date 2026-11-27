import { z } from 'zod';

/** At most this many lines in one `files:importUrls` request. */
export const MAX_IMPORT_URLS = 5000;
/** At most this many origins on one file. */
export const MAX_FILE_ORIGINS = 50;
/** A longer line is reported as invalid by the use case, not refused by the schema. */
export const IMPORT_URL_LINE_MAX = 2000;

const IdSchema = z.uuid();
const count = z.number().int().nonnegative();

/** `line` counts from 1 over the lines as sent; `text` is cut to 200 characters. */
export const UrlImportResultSchema = z.object({
  queued: count,
  alreadyImported: count,
  alreadyQueued: count,
  invalid: z.array(z.object({ line: z.number().int().min(1), text: z.string().max(200) })),
});
export type UrlImportResult = z.infer<typeof UrlImportResultSchema>;

/** An address a file was downloaded from. */
export const FileOriginSchema = z.object({ id: IdSchema, url: z.string(), createdAt: z.iso.datetime() });
export type FileOrigin = z.infer<typeof FileOriginSchema>;
