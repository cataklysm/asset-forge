import {
  PARALLEL_REQUESTS_MAX,
  PARALLEL_REQUESTS_MIN,
  type ProviderKind,
  type Thinking,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
} from '@assetforge/contracts';

/** The state of a provider entry, as the provider select and the settings show it. */
export const PROVIDER_STATE_LABELS = {
  checking: 'checking',
  ready: 'ready',
  unreachable: 'not reachable',
  unauthorized: 'key refused',
  no_vision_model: 'no vision model',
  no_edit_model: 'no edit model',
  error: 'error',
} as const;

/** The kind of a provider entry (ProviderSettings). */
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible',
  venice: 'Venice',
};
export const PROVIDER_KIND_LABEL = 'Kind';
export const EDIT_MODEL_LABEL = 'Edit model';

/** The provider select (ProviderSelect). */
export const PROVIDER_LABEL = 'Provider';
export const NO_PROVIDER = 'No provider';

/**
 * 'RunPod — ready'.
 *
 * @param name the provider entry's name
 * @param state the label of its state
 * @returns the option text of the provider select
 */
export function providerOptionLabel(name: string, state: string): string {
  return `${name} — ${state}`;
}

/** Why nothing can start while the selected provider is asked for its models (see `providerGate`). */
export const PROVIDER_CHECKING = 'The provider is being checked';

/** The provider section of the settings (ProviderSettings). */
export const PROVIDERS_TITLE = 'Vision providers';
export const PROVIDERS_LIST_LABEL = 'Providers';
export const NEW_PROVIDER_LABEL = 'New';
export const NEW_PROVIDER_TITLE = 'Adds a provider';
export const PROVIDER_LIMIT_TITLE = 'No more than 10 providers';
export const DELETE_PROVIDER_TITLE = 'Deletes the provider; asks first';
export const PROVIDER_NAME_LABEL = 'Name';
export const PROVIDER_NAME_TITLE = 'Shown in the analysis dialogs and the jobs; unique';
export const BASE_URL_LABEL = 'Base URL';
export const BASE_URL_TITLE = 'Address of the provider server (http or https)';
export const OPENAI_BASE_URL_PLACEHOLDER = 'http://localhost:8000/v1';
export const API_KEY_LABEL = 'API key';
export const API_KEY_TITLE = 'Sent as a bearer token to this server only; a stored key is never shown again';
export const NO_KEY_STORE_TITLE = 'The system credential store is not available, so no key can be saved';
export const KEY_STORED = 'Stored';
export const REMOVE_KEY_LABEL = 'Remove key';
export const REMOVE_KEY_TITLE = 'Deletes the stored key on save';
/** Shown in place of `KEY_STORED` while the stored key is to be deleted on save. */
export const KEY_REMOVAL_PENDING = 'Removed on save';
/** The action that withdraws a pending key removal. */
export const UNDO_REMOVE_KEY_LABEL = 'Undo';
/** The tooltip of `UNDO_REMOVE_KEY_LABEL`. */
export const UNDO_REMOVE_KEY_TITLE = 'Keeps the stored key';
export const TIMEOUT_LABEL = 'Timeout (s)';
export const TIMEOUT_TITLE = `Seconds to wait for one answer (${VISION_TIMEOUT_MIN_SECONDS}–${VISION_TIMEOUT_MAX_SECONDS})`;
export const TIMEOUT_INVALID = `The timeout must be a whole number from ${VISION_TIMEOUT_MIN_SECONDS} to ${VISION_TIMEOUT_MAX_SECONDS}`;
export const TAGGING_MODEL_TITLE = 'Model that tags images';
export const PROMPT_MODEL_TITLE = 'Model that writes a prompt from an image';
export const EDIT_MODEL_TITLE = 'Model that edits and generates images';
export const PROVIDER_KIND_TITLE = 'Ollama and OpenAI-compatible providers analyse images, Venice generates them';
export const TEMPERATURE_LABEL = 'Temperature';
export const TEMPERATURE_TITLE = '0 gives the most repeatable answers';
export const TEMPERATURE_INVALID = 'The temperature must be a number from 0 to 2';
export const THINKING_LABEL = 'Thinking';
export const THINKING_TITLE =
  'Sent as think (Ollama) or chat_template_kwargs.enable_thinking (OpenAI-compatible). For other models leave Server default and use Extra parameters';
export const THINKING_LABELS: Record<Thinking, string> = { default: 'Server default', off: 'Off', on: 'On' };
export const MAX_TOKENS_LABEL = 'Max. answer tokens';
export const MAX_TOKENS_TITLE = 'Empty: the server decides';
export const MAX_TOKENS_INVALID = 'The answer tokens must be empty or a whole number from 1 to 100000';
export const EXTRA_PARAMETERS_LABEL = 'Extra parameters';
export const EXTRA_PARAMETERS_TITLE = 'A JSON object merged into every request of this provider';
export const PARALLEL_REQUESTS_LABEL = 'Parallel requests';
export const PARALLEL_REQUESTS_TITLE = 'Analysis requests sent at the same time';
export const PARALLEL_REQUESTS_INVALID = `The parallel requests must be a whole number from ${PARALLEL_REQUESTS_MIN} to ${PARALLEL_REQUESTS_MAX}`;
/** The checkbox of an `openai` entry that decides whether tagging sends `response_format`. */
export const STRUCTURED_OUTPUT_LABEL = 'Structured output';
/** The tooltip of `STRUCTURED_OUTPUT_LABEL`. */
export const STRUCTURED_OUTPUT_TITLE =
  'Ask the server for the tag answer as a JSON schema; turn off for servers that refuse it';
export const PROVIDER_STATE_LABEL = 'State';
export const FROM_ENVIRONMENT = 'From environment';
export const FROM_ENVIRONMENT_TITLE = 'The provider comes from the environment and cannot be changed here';
export const ENTER_BASE_URL = 'Enter a base URL';

/**
 * 'Delete the provider RunPod?'.
 *
 * @param name the provider entry's name
 * @returns the title of the delete confirmation
 */
export function deleteProviderTitle(name: string): string {
  return `Delete the provider ${name}?`;
}

/** A failed load of the provider settings; not the same as "not configured". */
export const SETTINGS_LOAD_FAILED = 'The provider settings could not be read';
/** Shown above a held provider list whose reload failed. */
export const PROVIDERS_RELOAD_FAILED = 'The provider list could not be reloaded';
