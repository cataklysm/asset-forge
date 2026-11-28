import { z } from 'zod';

export type ChannelContracts = Record<string, { request: z.ZodType; response: z.ZodType }>;

export const EmptyRequestSchema = z.object({});
export const IdSchema = z.uuid();
export const IdRequestSchema = z.object({ id: IdSchema });
/** The most ids one `files:list` or `jobs:list` request may choose. */
export const MAX_CHOSEN_IDS = 100;
/**
 * Narrows a list to these rows, within its scope and every other filter: how a list fetches the rows the change feed
 * named. Distinct ids. A list filter only, never part of an analysis target.
 */
export const ChosenIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(MAX_CHOSEN_IDS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'The chosen ids must be distinct' });
