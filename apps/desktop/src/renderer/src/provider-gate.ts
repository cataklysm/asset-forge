import { JOB_ERROR_MESSAGES } from '@assetforge/contracts';
import type { AnalysisPromptsState } from './analysis-prompts-context';
import {
  CHOOSE_MODEL,
  CHOOSE_PROMPT,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_VISION_MODEL,
  PROVIDER_CHECKING,
  PROMPTS_LOAD_FAILED,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from './labels';
import { providerStatus, type ProvidersState } from './provider-context';

/**
 * Why nothing can start with the analysis prompt `promptId`, as the start button's tooltip; null
 * when it can. A failed prompt load is its own state, like a failed settings load in `providerGate`.
 */
export function promptGate(
  state: Pick<AnalysisPromptsState, 'prompts' | 'loading' | 'failed'>,
  promptId: string | null,
): string | null {
  if (state.failed) return PROMPTS_LOAD_FAILED;
  if (state.prompts === null) return START_LOADING;
  if (promptId === null || !state.prompts.some((p) => p.id === promptId)) return CHOOSE_PROMPT;
  return null;
}

/** Model list failures the settings screen fixes. */
const SETTINGS_CODES: ReadonlySet<string> = new Set(['provider_unauthorized', 'provider_not_configured']);

export interface ProviderGate {
  /** Why nothing can start with `model`, as the tooltip of the disabled start; null when it can. */
  blocked: string | null;
  /** Whether the settings screen is the way out; never depends on anything but provider and model. */
  offerSettings: boolean;
}

/**
 * The provider side of the analysis and prompt dialogs, shared so all three agree, applied to the
 * selected entry: a failed list load is its own state (not "no provider"), an entry still being
 * asked cannot start, and a model the entry's loaded list does not contain cannot start.
 */
export function providerGate(
  state: Pick<ProvidersState, 'list' | 'models' | 'loading' | 'failed'>,
  providerId: string | null,
  model: string | null,
): ProviderGate {
  const { list, loading } = state;
  if (list === null) {
    const failed = state.failed && !loading;
    return { blocked: failed ? SETTINGS_LOAD_FAILED : START_LOADING, offerSettings: failed };
  }
  if (providerId === null || !list.providers.some((p) => p.id === providerId))
    return { blocked: JOB_ERROR_MESSAGES.provider_not_configured, offerSettings: !loading };
  const status = providerStatus(state, providerId);
  if (status === 'checking') return { blocked: PROVIDER_CHECKING, offerSettings: false };
  const answer = state.models[providerId]!;
  if (!answer.ok) {
    // A list that cannot be used leaves nothing to choose from when no model is chosen.
    const offerSettings = !loading && (SETTINGS_CODES.has(answer.code) || model === null);
    return { blocked: JOB_ERROR_MESSAGES[answer.code], offerSettings };
  }
  if (status === 'no_vision_model') return { blocked: NO_VISION_MODEL, offerSettings: !loading };
  const blocked =
    model === null
      ? CHOOSE_MODEL
      : !answer.models.some((m) => m.name === model)
        ? MODEL_NOT_LISTED
        : answer.models.some((m) => m.name === model && m.vision === false)
          ? MODEL_NOT_VISION
          : null;
  return { blocked, offerSettings: false };
}
