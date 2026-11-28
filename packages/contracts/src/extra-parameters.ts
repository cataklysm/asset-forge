import type { VisionKind } from './provider-ref';

export const PROVIDER_EXTRA_MAX = 4000;

/** Top-level keys the extra parameters must not set, because the adapter owns them. */
export const RESERVED_EXTRA_KEYS: Record<VisionKind, readonly string[]> = Object.freeze({
  ollama: Object.freeze(['model', 'messages', 'stream', 'format']),
  openai: Object.freeze(['model', 'messages', 'stream', 'response_format', 'n', 'tools', 'tool_choice']),
});

export type ExtraParameters =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'not_json' | 'not_object' }
  | { ok: false; reason: 'reserved'; key: string };

/**
 * Parses the extra parameters of a vision entry: empty or blank text is `{}`, otherwise the text
 * must be a JSON object without a top-level key reserved for the kind. Nested keys are not checked.
 */
export function parseExtraParameters(text: string, kind: VisionKind): ExtraParameters {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'not_object' };
  const value = parsed as Record<string, unknown>;
  const key = RESERVED_EXTRA_KEYS[kind].find((reserved) => Object.hasOwn(value, reserved));
  if (key !== undefined) return { ok: false, reason: 'reserved', key };
  return { ok: true, value };
}

/** The fixed message of a refused text. */
export function extraParametersMessage(refusal: Extract<ExtraParameters, { ok: false }>): string {
  return refusal.reason === 'reserved'
    ? `The extra parameters must not set ${refusal.key}`
    : 'The extra parameters are not a JSON object';
}
