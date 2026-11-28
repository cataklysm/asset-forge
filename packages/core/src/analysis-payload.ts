import { AnalyzeFilePayloadSchema, type AnalyzeFilePayload } from '@assetforge/contracts';

/**
 * The payload of an analysis job moved onto another provider: always v4 with that provider's name and
 * the chosen model. Mode and prompt stay; a v1 row becomes mode `apply`
 * and a v1 or v2 row `prompt: null`, so it still runs with the legacy text and limit. A payload that does
 * not parse (for example one of a newer app version) is returned unchanged, so the moved job still fails
 * `internal_error` instead of running with the legacy request.
 *
 * @param payload the stored payload
 * @param to the name and the chosen model of the provider the job moves to
 * @returns the rewritten payload, or the stored one when it does not parse
 */
export function rewriteForProvider(
  payload: unknown,
  to: { name: string; model: string },
): AnalyzeFilePayload | unknown {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  if (!parsed.success) return payload;
  const stored = parsed.data;
  return {
    version: 4,
    model: to.model,
    mode: stored.version === 1 ? 'apply' : stored.mode,
    prompt: stored.version === 3 || stored.version === 4 ? stored.prompt : null,
    providerName: to.name,
  };
}

/**
 * The payload of an analysis job without a provider assigned to `entry`: v4 with the payload's own model,
 * mode and prompt. A v1 row takes the entry's tagging model in mode `apply`.
 *
 * @param payload the stored payload
 * @param entry the name and the tagging model of the provider entry
 * @returns the v4 payload; null (left as it is) when the entry has no tagging model for a v1 row or the payload
 *   does not parse
 */
export function adoptForProvider(
  payload: unknown,
  entry: { name: string; taggingModel: string | null },
): AnalyzeFilePayload | null {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const stored = parsed.data;
  if (stored.version === 1) {
    if (entry.taggingModel === null) return null;
    return { version: 4, model: entry.taggingModel, mode: 'apply', prompt: null, providerName: entry.name };
  }
  return {
    version: 4,
    model: stored.model,
    mode: stored.mode,
    prompt: stored.version === 2 ? null : stored.prompt,
    providerName: entry.name,
  };
}
