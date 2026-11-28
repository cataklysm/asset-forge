import { ImageModelSchema, ModelNameSchema, type ImageModel } from '@assetforge/contracts';

function constraintList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  if (!value.every((entry) => typeof entry === 'string' && entry.length >= 1 && entry.length <= 20)) return null;
  return [...(value as string[])];
}

function usdOf(value: unknown): number | null {
  const usd = (value as { usd?: unknown } | null)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/** The display text of the USD value of `pricing` (on the object itself or one level below), else null. */
function priceOf(pricing: unknown): string | null {
  if (pricing === null || typeof pricing !== 'object') return null;
  const usd = usdOf(pricing) ?? Object.values(pricing).map(usdOf).find((value) => value !== null) ?? null;
  if (usd === null) return null;
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function modelOf(entry: unknown): ImageModel | null {
  if (entry === null || typeof entry !== 'object') return null;
  const { id, model_spec: spec } = entry as { id?: unknown; model_spec?: unknown };
  const name = ModelNameSchema.safeParse(id);
  if (!name.success) return null;
  const { constraints, pricing } = (spec !== null && typeof spec === 'object' ? spec : {}) as { constraints?: unknown; pricing?: unknown };
  const c = (constraints !== null && typeof constraints === 'object' ? constraints : {}) as Record<string, unknown>;
  const defaultResolution = c.defaultResolution;
  const limit = c.promptCharacterLimit;
  const model = {
    name: name.data,
    aspectRatios: constraintList(c.aspectRatios),
    resolutions: constraintList(c.resolutions),
    defaultResolution:
      typeof defaultResolution === 'string' && defaultResolution.length >= 1 && defaultResolution.length <= 20 ? defaultResolution : null,
    promptCharacterLimit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    price: priceOf(pricing),
  };
  const parsed = ImageModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}
