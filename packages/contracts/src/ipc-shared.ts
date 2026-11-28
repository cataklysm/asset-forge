import { z } from 'zod';

/** The shape every channel family has: per channel name, the schema of its request and of its answer. */
export type ChannelContracts = Record<string, { request: z.ZodType; response: z.ZodType }>;

/** The request of a channel that takes nothing, and the answer of one that answers nothing. */
export const EmptyRequestSchema = z.object({});
/** The id of a row. */
export const IdSchema = z.uuid();
/** A number of rows or items: a whole number of at least zero. */
export const CountSchema = z.number().int().nonnegative();
/** A request that names one row by its id. */
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
