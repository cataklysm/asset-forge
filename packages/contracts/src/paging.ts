import { z } from 'zod';

const count = z.number().int().min(0);

/** The page a list request asks for: at most 200 rows from `offset` on. */
export const PageRequestSchema = z.object({
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().min(0),
});
/** The page a list request asks for. */
export type PageRequest = z.infer<typeof PageRequestSchema>;

/**
 * The schema of one page of a list.
 *
 * @param item the schema of one row
 * @returns a schema of `{ items, total }`, where `total` counts the rows of the whole list
 */
export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: count });
