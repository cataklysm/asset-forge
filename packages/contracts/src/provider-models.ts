import { z } from 'zod';
import { JobErrorCodeSchema } from './job-errors';
import { ModelNameSchema } from './provider-ref';

/** A model of the provider; `vision` is null when the server does not report capabilities. */
export const VisionModelSchema = z.object({ name: ModelNameSchema, vision: z.boolean().nullable() });
/** A model of a vision entry. */
export type VisionModel = z.infer<typeof VisionModelSchema>;

/** The models of a vision entry, or the code of the failure; a provider that cannot list them is a result. */
export const ListModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(VisionModelSchema).max(100) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
/** The answer of `providers:listModels`. */
export type ListModelsResult = z.infer<typeof ListModelsResultSchema>;

/** The values a model allows for one parameter; null when the provider does not report them. */
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
/** An image edit model of a `venice` entry. */
export type ImageModel = z.infer<typeof ImageModelSchema>;

/** The image edit models of a `venice` entry, or the code of the failure. */
export const ListImageModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(ImageModelSchema).max(200) }),
  z.object({ ok: z.literal(false), code: JobErrorCodeSchema }),
]);
/** The answer of `providers:listImageModels`. */
export type ListImageModelsResult = z.infer<typeof ListImageModelsResultSchema>;
