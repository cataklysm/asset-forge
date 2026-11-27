import type { VisionRequestOptions } from '@assetforge/contracts';

/** The options of an entry that sets none: today's request bodies. */
export const DEFAULT_REQUEST_OPTIONS: VisionRequestOptions = Object.freeze({
  temperature: 0,
  thinking: 'default',
  maxTokens: null,
  extra: Object.freeze({}) as Record<string, unknown>,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fixed fields, then `extra` over them, then `own` over everything. Objects under `deepKeys` are
 * merged one level deep, every other key is replaced. The arguments are not changed.
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

/** `POST /api/chat`: `{ options: { temperature, [num_predict] }, [think] }`. */
export function ollamaFixedFields(o: VisionRequestOptions): Record<string, unknown> {
  return {
    options: { temperature: o.temperature, ...(o.maxTokens === null ? {} : { num_predict: o.maxTokens }) },
    ...(o.thinking === 'default' ? {} : { think: o.thinking === 'on' }),
  };
}

/** `POST /chat/completions`: `{ temperature, [max_tokens], [chat_template_kwargs: { enable_thinking }] }`. */
export function openAiFixedFields(o: VisionRequestOptions): Record<string, unknown> {
  return {
    temperature: o.temperature,
    ...(o.maxTokens === null ? {} : { max_tokens: o.maxTokens }),
    ...(o.thinking === 'default' ? {} : { chat_template_kwargs: { enable_thinking: o.thinking === 'on' } }),
  };
}
