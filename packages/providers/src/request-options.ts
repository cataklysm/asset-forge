import type { VisionRequestOptions } from '@assetforge/contracts';

/** The options of an entry that sets none: today's request bodies. */
export const DEFAULT_REQUEST_OPTIONS: VisionRequestOptions = Object.freeze({
  temperature: 0,
  thinking: 'default',
  maxTokens: null,
  extra: Object.freeze({}) as Record<string, unknown>,
});

/**
 * Whether a value is a plain object.
 *
 * @param value any value
 * @returns true for an object that is neither null nor an array
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fixed fields, then `extra` over them, then `own` over everything. Objects under `deepKeys` are
 * merged one level deep, every other key is replaced. The arguments are not changed.
 *
 * @param fixed the fields the request options set
 * @param extra the entry's extra parameters
 * @param own the adapter's own fields, which always win
 * @param deepKeys the keys whose objects `extra` merges into
 * @returns the request body
 */
export function composeBody(
  fixed: Record<string, unknown>,
  extra: Record<string, unknown>,
  own: Record<string, unknown>,
  deepKeys: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fixed };
  for (const [key, value] of Object.entries(extra)) {
    const current = body[key];
    body[key] =
      deepKeys.includes(key) && isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return { ...body, ...own };
}

/**
 * `POST /api/chat`: `{ options: { temperature, [num_predict] }, [think] }`.
 *
 * @param options the entry's request options
 * @returns the fixed fields
 */
export function ollamaFixedFields(options: VisionRequestOptions): Record<string, unknown> {
  return {
    options: {
      temperature: options.temperature,
      ...(options.maxTokens === null ? {} : { num_predict: options.maxTokens }),
    },
    ...(options.thinking === 'default' ? {} : { think: options.thinking === 'on' }),
  };
}

/**
 * `POST /chat/completions`: `{ temperature, [max_tokens], [chat_template_kwargs: { enable_thinking }] }`.
 *
 * @param options the entry's request options
 * @returns the fixed fields
 */
export function openAiFixedFields(options: VisionRequestOptions): Record<string, unknown> {
  return {
    temperature: options.temperature,
    ...(options.maxTokens === null ? {} : { max_tokens: options.maxTokens }),
    ...(options.thinking === 'default' ? {} : { chat_template_kwargs: { enable_thinking: options.thinking === 'on' } }),
  };
}
