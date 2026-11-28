import { z } from 'zod';
import { JobErrorCodeSchema } from './job-errors';
import { ModelNameSchema } from './provider-ref';

/** A model of the provider; `vision` is null when the server does not report capabilities. */
export const VisionModelSchema = z.object({ name: ModelNameSchema, vision: z.boolean().nullable() });
export type VisionModel = z.infer<typeof VisionModelSchema>;

export const ListModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(VisionModelSchema).max(100) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
export type ListModelsResult = z.infer<typeof ListModelsResultSchema>;

const ImageConstraintListSchema = z.array(z.string().min(1).max(20)).max(50).nullable();

/** An image edit model of a `venice` entry; a null constraint is one the provider does not report. */
export const ImageModelSchema = z.object({
  name: ModelNameSchema,
  aspectRatios: ImageConstraintListSchema,
  resolutions: ImageConstraintListSchema,
  defaultResolution: z.string().min(1).max(20).nullable(),
  promptCharacterLimit: z.number().int().positive().nullable(),
  price: z.string().max(200).nullable(),
});
export type ImageModel = z.infer<typeof ImageModelSchema>;

export const ListImageModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(ImageModelSchema).max(200) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
export type ListImageModelsResult = z.infer<typeof ListImageModelsResultSchema>;
