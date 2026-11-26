import { JOB_ERROR_MESSAGES } from '@assetforge/contracts';
import {
  CHOOSE_MODEL,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_VISION_MODEL,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from './labels';
import type { ProviderState } from './provider-context';

/** Model list failures the settings screen fixes. */
const SETTINGS_CODES: ReadonlySet<string> = new Set(['provider_unauthorized', 'provider_not_configured']);

export interface ProviderGate {
  /** Why nothing can start with `model`, as the tooltip of the disabled start; null when it can. */
  blocked: string | null;
  /** Whether the settings screen is the way out; never depends on anything but provider and model. */
  offerSettings: boolean;
}

/**
 * The provider side of the analysis and prompt dialogs, shared so all three agree: a failed
 * settings load is its own state (not "not configured"), and a model the loaded list does not
 * contain cannot start.
 */
export function providerGate(
  provider: Pick<ProviderState, 'settings' | 'models' | 'loading' | 'settingsFailed'>,
  model: string | null,
): ProviderGate {
  const { settings, models, loading } = provider;
  const failed = settings === null && provider.settingsFailed && !loading;
  const notConfigured = settings !== null && settings.baseUrl === null;
  const list = models !== null && models.ok ? models.models : null;
  const noVisionModel = list !== null && !list.some((m) => m.vision !== false);
  const notListed = list !== null && model !== null && !list.some((m) => m.name === model);
  const notVision = list !== null && list.some((m) => m.name === model && m.vision === false);
  const listRefused = models !== null && !models.ok && SETTINGS_CODES.has(models.code);
  // A list that cannot be used leaves nothing to choose from when no model is stored.
  const listUnusable = settings !== null && !notConfigured && list === null && model === null;

  const blocked = failed
    ? SETTINGS_LOAD_FAILED
    : settings === null
      ? START_LOADING
      : notConfigured
        ? JOB_ERROR_MESSAGES.provider_not_configured
        : noVisionModel
          ? NO_VISION_MODEL
          : model === null
            ? CHOOSE_MODEL
            : notListed
              ? MODEL_NOT_LISTED
              : notVision
                ? MODEL_NOT_VISION
                : null;
  const offerSettings =
    !loading && (failed || notConfigured || noVisionModel || listRefused || listUnusable);
  return { blocked, offerSettings };
}
