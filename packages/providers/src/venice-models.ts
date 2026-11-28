import { ImageModelSchema, ModelNameSchema, type ImageModel } from '@assetforge/contracts';

/** At most this many models of a list answer are kept. */
const MAX_MODELS = 200;

/**
 * The models of a `GET /models?type=inpaint` answer; an entry that does not parse is left out.
 *
 * @param text the answer's body
 * @returns at most `MAX_MODELS` models; null when the body is not JSON with a `data` array
 */
export function modelsOfAnswer(text: string): ImageModel[] | null {
  let data: unknown;
  try {
    data = (JSON.parse(text) as { data?: unknown } | null)?.data;
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data
    .map(modelOf)
    .filter((model): model is ImageModel => model !== null)
    .slice(0, MAX_MODELS);
}

/**
 * A list of short values from a model's constraints.
 *
 * @param value the stated constraint
 * @returns a copy of 1 to 50 strings of 1 to 20 characters; null for anything else
 */
function constraintList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  if (!value.every((entry) => typeof entry === 'string' && entry.length >= 1 && entry.length <= 20)) return null;
  return [...(value as string[])];
}

/**
 * The `usd` field of a value.
 *
 * @param value an object that may carry `usd`
 * @returns a finite, non-negative number; null for anything else
 */
function usdOf(value: unknown): number | null {
  const usd = (value as { usd?: unknown } | null)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/**
 * The display text of the USD value of `pricing` (on the object itself or one level below).
 *
 * @param pricing the model's stated pricing
 * @returns e.g. `$0.04`; null when no USD value is found
 */
function priceOf(pricing: unknown): string | null {
  if (pricing === null || typeof pricing !== 'object') return null;
  const usd = usdOf(pricing) ?? Object.values(pricing).map(usdOf).find((value) => value !== null) ?? null;
  if (usd === null) return null;
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

/**
 * Whether a value is an object.
 *
 * @param value the value
 * @returns true for any non-null object
 */
function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * One model of a list answer.
 *
 * @param entry an entry of the answer's `data`
 * @returns the model; null when its name or the result does not pass the schemas
 */
function modelOf(entry: unknown): ImageModel | null {
  if (entry === null || typeof entry !== 'object') return null;
  const { id, model_spec: specification } = entry as { id?: unknown; model_spec?: unknown };
  const name = ModelNameSchema.safeParse(id);
  if (!name.success) return null;
  const { constraints: statedConstraints, pricing } = (isObject(specification) ? specification : {}) as {
    constraints?: unknown;
    pricing?: unknown;
  };
  const constraints = (isObject(statedConstraints) ? statedConstraints : {}) as Record<string, unknown>;
  const defaultResolution = constraints.defaultResolution;
  const limit = constraints.promptCharacterLimit;
  const model = {
    name: name.data,
    aspectRatios: constraintList(constraints.aspectRatios),
    resolutions: constraintList(constraints.resolutions),
    defaultResolution:
      typeof defaultResolution === 'string' && defaultResolution.length >= 1 && defaultResolution.length <= 20
        ? defaultResolution
        : null,
    promptCharacterLimit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    price: priceOf(pricing),
  };
  const parsed = ImageModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}
