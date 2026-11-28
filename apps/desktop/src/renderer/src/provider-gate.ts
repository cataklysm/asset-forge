import {
  JOB_ERROR_MESSAGES,
  purposeOf,
  type AnalysisPromptPurpose,
  type ProviderPurpose,
  type VisionModel,
} from '@assetforge/contracts';
import type { AnalysisPromptsState } from './analysis-prompts-context';
import {
  CHOOSE_MODEL,
  CHOOSE_PROMPT,
  MODEL_NOT_DESCRIBE,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_DESCRIBE_MODEL,
  NO_VISION_MODEL,
  PROVIDER_CHECKING,
  PROVIDER_STATE_LABELS,
  PROMPTS_LOAD_FAILED,
  PROMPTS_LOADING,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from './labels';
import type { ProvidersState } from './provider-context';

/**
 * Why nothing can start with the analysis prompt `promptId`, as the start button's tooltip. A failed
 * prompt load is its own state, like a failed settings load in `providerGate`.
 *
 * @param state the loaded analysis prompts
 * @param promptId the chosen prompt; null when none is chosen
 * @param purpose the purpose of the dialog; a prompt of the other purpose cannot start
 * @returns the reason, null when a start can go ahead
 */
export function promptGate(
  state: Pick<AnalysisPromptsState, 'prompts' | 'loading' | 'failed'>,
  promptId: string | null,
  purpose: AnalysisPromptPurpose,
): string | null {
  if (state.failed) return PROMPTS_LOAD_FAILED;
  if (state.prompts === null) return PROMPTS_LOADING;
  if (promptId === null || !state.prompts.some((prompt) => prompt.id === promptId && prompt.purpose === purpose))
    return CHOOSE_PROMPT;
  return null;
}

/** Model list failures the settings screen fixes. */
const SETTINGS_CODES: ReadonlySet<string> = new Set(['provider_unauthorized', 'provider_not_configured']);

/** What the provider side of a dialog decides. */
export interface ProviderGate {
  /** Why nothing can start with `model`, as the tooltip of the disabled start; null when it can. */
  blocked: string | null;
  /** Whether the settings screen is the way out; never depends on anything but provider and model. */
  offerSettings: boolean;
}

/** The parts of the provider state a gate reads. */
type GateState = Pick<ProvidersState, 'list' | 'models' | 'imageModels' | 'loading' | 'failed'>;

/** The names of the models in a loaded list. */
interface Loaded {
  names: readonly string[];
}

/**
 * The part both kinds share: a failed list load is its own state (not "no provider"), an entry not
 * listed with `purpose` is not configured, an entry still being asked cannot start, and a model list
 * that could not be loaded blocks with its code. Otherwise the loaded list of the entry.
 *
 * @param state the provider state
 * @param purpose the purpose the entry must be listed with
 * @param providerId the selected entry; null when none is selected
 * @param model the chosen model; null when none is chosen
 * @returns the gate when it already decides, else the names of the entry's models
 */
function entryGate(
  state: GateState,
  purpose: ProviderPurpose,
  providerId: string | null,
  model: string | null,
): ProviderGate | Loaded {
  const { list, loading } = state;
  if (list === null) {
    const failed = state.failed && !loading;
    return { blocked: failed ? SETTINGS_LOAD_FAILED : START_LOADING, offerSettings: failed };
  }
  if (
    providerId === null ||
    !list.providers.some((entry) => entry.id === providerId && purposeOf(entry.kind) === purpose)
  )
    return { blocked: JOB_ERROR_MESSAGES.provider_not_configured, offerSettings: !loading };
  const answer = purpose === 'image' ? state.imageModels[providerId] : state.models[providerId];
  if (answer === undefined || answer === 'checking') return { blocked: PROVIDER_CHECKING, offerSettings: false };
  if (!answer.ok) {
    // A list that cannot be used leaves nothing to choose from when no model is chosen.
    const offerSettings = !loading && (SETTINGS_CODES.has(answer.code) || model === null);
    return { blocked: JOB_ERROR_MESSAGES[answer.code], offerSettings };
  }
  return { names: answer.models.map((entry) => entry.name) };
}

/** What a vision model is used for: tagging in the analysis dialogs, a prompt in Image to prompt. */
export type VisionUse = 'tagging' | 'prompt';

/** The texts of a missing vision model, worded for its use. */
const VISION_TEXTS: Record<VisionUse, { noModel: string; notVision: string }> = {
  tagging: { noModel: NO_VISION_MODEL, notVision: MODEL_NOT_VISION },
  prompt: { noModel: NO_DESCRIBE_MODEL, notVision: MODEL_NOT_DESCRIBE },
};

/**
 * The provider side of the analysis and prompt dialogs, shared so all three agree, applied to the
 * selected vision entry (Ollama or OpenAI-compatible): on top of `entryGate`, an entry without vision models offers the
 * settings, and a model the entry's loaded list does not contain, or one without vision, cannot start.
 *
 * @param state the provider state
 * @param providerId the selected entry; null when none is selected
 * @param model the chosen model; null when none is chosen
 * @param use what the model is used for; it words the reasons about vision
 * @returns the gate
 */
export function providerGate(
  state: GateState,
  providerId: string | null,
  model: string | null,
  use: VisionUse = 'tagging',
): ProviderGate {
  const gate = entryGate(state, 'vision', providerId, model);
  if (!('names' in gate)) return gate;
  const answer = state.models[providerId!];
  const models = answer !== undefined && answer.ok ? answer.models : [];
  if (!models.some((entry) => entry.vision !== false))
    return { blocked: VISION_TEXTS[use].noModel, offerSettings: !state.loading };
  return { blocked: visionModelBlocked(gate.names, models, model, use), offerSettings: false };
}

/**
 * Why the chosen vision model cannot start.
 *
 * @param names the names in the entry's loaded list
 * @param models the entry's loaded models
 * @param model the chosen model; null when none is chosen
 * @param use what the model is used for
 * @returns the reason, null when it can start
 */
function visionModelBlocked(
  names: readonly string[],
  models: readonly VisionModel[],
  model: string | null,
  use: VisionUse,
): string | null {
  if (model === null) return CHOOSE_MODEL;
  if (!names.includes(model)) return MODEL_NOT_LISTED;
  if (models.some((entry) => entry.name === model && entry.vision === false)) return VISION_TEXTS[use].notVision;
  return null;
}

/**
 * The provider side of the studio, applied to the selected image entry: on top of `entryGate`, an
 * entry without edit models offers the settings, and a model its loaded list does not contain
 * cannot start.
 *
 * @param state the provider state
 * @param providerId the selected entry; null when none is selected
 * @param model the chosen edit model; null when none is chosen
 * @returns the gate
 */
export function imageProviderGate(state: GateState, providerId: string | null, model: string | null): ProviderGate {
  const gate = entryGate(state, 'image', providerId, model);
  if (!('names' in gate)) return gate;
  if (gate.names.length === 0) return { blocked: PROVIDER_STATE_LABELS.no_edit_model, offerSettings: !state.loading };
  return { blocked: editModelBlocked(gate.names, model), offerSettings: false };
}

/**
 * Why the chosen edit model cannot start.
 *
 * @param names the names in the entry's loaded list
 * @param model the chosen model; null when none is chosen
 * @returns the reason, null when it can start
 */
function editModelBlocked(names: readonly string[], model: string | null): string | null {
  if (model === null) return CHOOSE_MODEL;
  if (!names.includes(model)) return MODEL_NOT_LISTED;
  return null;
}
