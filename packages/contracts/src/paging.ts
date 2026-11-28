import { z } from 'zod';

const count = z.number().int().min(0);

export const PageRequestSchema = z.object({
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().min(0),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: count });
