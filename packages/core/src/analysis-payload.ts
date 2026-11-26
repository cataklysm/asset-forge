import { AnalyzeFilePayloadSchema, type AnalyzeFilePayload } from '@assetforge/contracts';

/**
 * The payload of an analysis job moved onto another provider: always v4 with that provider's name and
 * the chosen model. Mode and prompt stay; a v1 row (or one that does not parse) becomes mode `apply`
 * and a v1 or v2 row `prompt: null`, so it still runs with the legacy text and limit.
 */
export function rewriteForProvider(payload: unknown, to: { name: string; model: string }): AnalyzeFilePayload {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  const p: AnalyzeFilePayload = parsed.success ? parsed.data : { version: 1 };
  return {
    version: 4,
    model: to.model,
    mode: p.version === 1 ? 'apply' : p.mode,
    prompt: p.version === 3 || p.version === 4 ? p.prompt : null,
    providerName: to.name,
  };
}

/**
 * The payload of an analysis job without a provider assigned to `entry`: v4 with the payload's own model,
 * mode and prompt. A v1 row takes the entry's tagging model in mode `apply`; null (left as it is) when the
 * entry has none or the payload does not parse.
 */
export function adoptForProvider(
  payload: unknown,
  entry: { name: string; taggingModel: string | null },
): AnalyzeFilePayload | null {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.version === 1) {
    if (entry.taggingModel === null) return null;
    return { version: 4, model: entry.taggingModel, mode: 'apply', prompt: null, providerName: entry.name };
  }
  return {
    version: 4,
    model: p.model,
    mode: p.mode,
    prompt: p.version === 2 ? null : p.prompt,
    providerName: entry.name,
  };
}
