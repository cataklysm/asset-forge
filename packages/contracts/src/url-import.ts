import { z } from 'zod';
import { CountSchema, IdSchema } from './ipc-shared';

/** At most this many lines in one `files:importUrls` request. */
export const MAX_IMPORT_URLS = 5000;
/** At most this many origins on one file. */
export const MAX_FILE_ORIGINS = 50;
/** A longer line is reported as invalid by the use case, not refused by the schema. */
export const IMPORT_URL_LINE_MAX = 2000;
/** The schema refuses a request holding a longer line; the dialog never sends one. */
export const IMPORT_URL_STRING_MAX = 10000;

/** `line` counts from 1 over the lines as sent; `text` is cut to 200 characters. */
export const UrlImportResultSchema = z.object({
  queued: CountSchema,
  alreadyImported: CountSchema,
  alreadyQueued: CountSchema,
  invalid: z.array(z.object({ line: z.number().int().min(1), text: z.string().max(200) })),
});
/** The answer of `files:importUrls`. */
export type UrlImportResult = z.infer<typeof UrlImportResultSchema>;

/** An address a file was downloaded from. */
export const FileOriginSchema = z.object({ id: IdSchema, url: z.string(), createdAt: z.iso.datetime() });
/** An address a file was downloaded from. */
export type FileOrigin = z.infer<typeof FileOriginSchema>;
