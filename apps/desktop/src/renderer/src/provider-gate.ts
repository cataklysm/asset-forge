import { JOB_ERROR_MESSAGES, purposeOf, type ProviderPurpose } from '@assetforge/contracts';
import type { AnalysisPromptsState } from './analysis-prompts-context';
import {
  CHOOSE_MODEL,
  CHOOSE_PROMPT,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_VISION_MODEL,
  PROVIDER_CHECKING,
  PROVIDER_STATE_LABELS,
  PROMPTS_LOAD_FAILED,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from './labels';
import type { ProvidersState } from './provider-context';

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

type GateState = Pick<ProvidersState, 'list' | 'models' | 'imageModels' | 'loading' | 'failed'>;

/** The names of the models in a loaded list. */
interface Loaded {
  names: readonly string[];
}

/**
 * The part both kinds share: a failed list load is its own state (not "no provider"), an entry not
 * listed with `purpose` is not configured, an entry still being asked cannot start, and a model list
 * that could not be loaded blocks with its code. Otherwise the loaded list of the entry.
 */
function entryGate(state: GateState, purpose: ProviderPurpose, providerId: string | null, model: string | null): ProviderGate | Loaded {
  const { list, loading } = state;
  if (list === null) {
    const failed = state.failed && !loading;
    return { blocked: failed ? SETTINGS_LOAD_FAILED : START_LOADING, offerSettings: failed };
  }
  if (providerId === null || !list.providers.some((p) => p.id === providerId && purposeOf(p.kind) === purpose))
    return { blocked: JOB_ERROR_MESSAGES.provider_not_configured, offerSettings: !loading };
  const answer = purpose === 'image' ? state.imageModels[providerId] : state.models[providerId];
  if (answer === undefined || answer === 'checking') return { blocked: PROVIDER_CHECKING, offerSettings: false };
  if (!answer.ok) {
    // A list that cannot be used leaves nothing to choose from when no model is chosen.
    const offerSettings = !loading && (SETTINGS_CODES.has(answer.code) || model === null);
    return { blocked: JOB_ERROR_MESSAGES[answer.code], offerSettings };
  }
  return { names: answer.models.map((m) => m.name) };
}

/**
 * The provider side of the analysis and prompt dialogs, shared so all three agree, applied to the
 * selected vision entry (Ollama or OpenAI-compatible): on top of `entryGate`, an entry without vision models offers the
 * settings, and a model the entry's loaded list does not contain, or one without vision, cannot start.
 */
export function providerGate(state: GateState, providerId: string | null, model: string | null): ProviderGate {
  const gate = entryGate(state, 'vision', providerId, model);
  if (!('names' in gate)) return gate;
  const answer = state.models[providerId!];
  const models = answer !== undefined && answer.ok ? answer.models : [];
  if (!models.some((m) => m.vision !== false)) return { blocked: NO_VISION_MODEL, offerSettings: !state.loading };
  const blocked =
    model === null
      ? CHOOSE_MODEL
      : !gate.names.includes(model)
        ? MODEL_NOT_LISTED
        : models.some((m) => m.name === model && m.vision === false)
          ? MODEL_NOT_VISION
          : null;
  return { blocked, offerSettings: false };
}

/**
 * The provider side of the studio, applied to the selected image entry: on top of `entryGate`, an
 * entry without edit models offers the settings, and a model its loaded list does not contain
 * cannot start.
 */
export function imageProviderGate(state: GateState, providerId: string | null, model: string | null): ProviderGate {
  const gate = entryGate(state, 'image', providerId, model);
  if (!('names' in gate)) return gate;
  if (gate.names.length === 0) return { blocked: PROVIDER_STATE_LABELS.no_edit_model, offerSettings: !state.loading };
  const blocked = model === null ? CHOOSE_MODEL : !gate.names.includes(model) ? MODEL_NOT_LISTED : null;
  return { blocked, offerSettings: false };
}
