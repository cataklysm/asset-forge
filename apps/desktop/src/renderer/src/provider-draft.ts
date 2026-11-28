import {
  DEFAULT_PROVIDER_OPTIONS,
  PARALLEL_REQUESTS_MAX,
  PARALLEL_REQUESTS_MIN,
  VENICE_DEFAULT_BASE_URL,
  VISION_TIMEOUT_DEFAULT_SECONDS,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  extraParametersMessage,
  isVisionKind,
  parseExtraParameters,
  type ProviderKind,
  type ProviderOptions,
  type ProviderView,
  type SaveProvider,
  type Thinking,
} from '@assetforge/contracts';
import {
  ENTER_BASE_URL,
  ENTER_NAME,
  MAX_TOKENS_INVALID,
  PARALLEL_REQUESTS_INVALID,
  TEMPERATURE_INVALID,
  TIMEOUT_INVALID,
} from './labels';

/** The fields of one provider entry, as typed. */
export interface ProviderDraft {
  /** Chosen only for an entry that is not saved yet. */
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  /** Write-only: never filled from the stored entry, cleared after a successful save. */
  apiKey: string;
  /** The stored key is deleted on save. */
  clearKey: boolean;
  timeout: string;
  taggingModel: string | null;
  promptModel: string | null;
  editModel: string | null;
  /** The request options of a vision entry, as typed; ignored for an image entry. */
  temperature: string;
  thinking: Thinking;
  /** Empty means not sent. */
  maxTokens: string;
  extra: string;
  parallelRequests: string;
}

/** The kinds a new entry can take, in the order the select offers them. */
export const KINDS: readonly ProviderKind[] = ['ollama', 'openai', 'venice'];

/** The thinking choices, in the order the select offers them. */
export const THINKING: readonly Thinking[] = ['default', 'off', 'on'];

/** The highest answer token limit. */
export const MAX_TOKENS_MAX = 100_000;

/**
 * The base URL a new entry of `kind` starts with.
 *
 * @param kind the kind
 * @returns the prefilled base URL; empty for a vision kind
 */
export const baseUrlOf = (kind: ProviderKind) => (kind === 'venice' ? VENICE_DEFAULT_BASE_URL : '');

/**
 * The draft of a stored entry, or of a new one.
 *
 * @param view the stored entry; null for a new one
 * @returns the draft
 */
export function draftOf(view: ProviderView | null): ProviderDraft {
  const options = view?.options ?? DEFAULT_PROVIDER_OPTIONS;
  return {
    kind: view?.kind ?? 'ollama',
    name: view?.name ?? '',
    baseUrl: view?.baseUrl ?? '',
    apiKey: '',
    clearKey: false,
    timeout: String(view?.timeoutSeconds ?? VISION_TIMEOUT_DEFAULT_SECONDS),
    taggingModel: view?.taggingModel ?? null,
    promptModel: view?.promptModel ?? null,
    editModel: view?.editModel ?? null,
    temperature: String(options.temperature),
    thinking: options.thinking,
    maxTokens: options.maxTokens === null ? '' : String(options.maxTokens),
    extra: options.extra,
    parallelRequests: String(options.parallelRequests),
  };
}

/**
 * The timeout in seconds.
 *
 * @param text the typed text
 * @returns the timeout, or null when it is not a whole number in range
 */
export function timeoutOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= VISION_TIMEOUT_MIN_SECONDS && value <= VISION_TIMEOUT_MAX_SECONDS ? value : null;
}

/**
 * The parallel requests.
 *
 * @param text the typed text
 * @returns the count, or null when it is not a whole number in range
 */
export function parallelRequestsOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= PARALLEL_REQUESTS_MIN && value <= PARALLEL_REQUESTS_MAX ? value : null;
}

/**
 * The temperature.
 *
 * @param text the typed text
 * @returns the temperature, or null when the text is empty, not a number (`0,5`) or outside 0–2
 */
export function temperatureOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : null;
}

/**
 * The answer token limit.
 *
 * @param text the typed text
 * @returns null for an empty text (not sent), undefined when it is not a whole number 1–100000, else the limit
 */
export function maxTokensOf(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_TOKENS_MAX ? value : undefined;
}

/**
 * Why the extra parameters of the draft cannot be sent with its kind.
 *
 * @param draft the draft
 * @returns the message; null when they can or the kind takes none
 */
export function extraMessageOf(draft: ProviderDraft): string | null {
  if (!isVisionKind(draft.kind)) return null;
  const parsed = parseExtraParameters(draft.extra, draft.kind);
  return parsed.ok ? null : extraParametersMessage(parsed);
}

/**
 * The request options of a valid vision draft as sent.
 *
 * @param draft the draft, valid
 * @returns the options
 */
const optionsOf = (draft: ProviderDraft): ProviderOptions => ({
  temperature: temperatureOf(draft.temperature)!,
  thinking: draft.thinking,
  maxTokens: maxTokensOf(draft.maxTokens)!,
  extra: draft.extra,
  parallelRequests: parallelRequestsOf(draft.parallelRequests)!,
});

/**
 * Why the draft cannot be saved.
 *
 * @param draft the draft
 * @returns the reason, or null when it can be saved
 */
export function invalidReason(draft: ProviderDraft): string | null {
  if (draft.name.trim() === '') return ENTER_NAME;
  if (draft.baseUrl.trim() === '') return ENTER_BASE_URL;
  if (timeoutOf(draft.timeout) === null) return TIMEOUT_INVALID;
  if (isVisionKind(draft.kind)) {
    if (temperatureOf(draft.temperature) === null) return TEMPERATURE_INVALID;
    if (maxTokensOf(draft.maxTokens) === undefined) return MAX_TOKENS_INVALID;
    if (parallelRequestsOf(draft.parallelRequests) === null) return PARALLEL_REQUESTS_INVALID;
    return extraMessageOf(draft);
  }
  return null;
}

/**
 * The save request of a valid draft.
 *
 * @param sent the draft, valid
 * @param entry the stored entry; null for a new one
 * @returns the request
 */
export function saveInputOf(sent: ProviderDraft, entry: ProviderView | null): SaveProvider {
  const venice = sent.kind === 'venice';
  const input: SaveProvider = {
    name: sent.name.trim(),
    baseUrl: sent.baseUrl.trim(),
    timeoutSeconds: timeoutOf(sent.timeout)!,
    taggingModel: venice ? null : sent.taggingModel,
    promptModel: venice ? null : sent.promptModel,
  };
  if (venice) input.editModel = sent.editModel;
  if (isVisionKind(sent.kind)) input.options = optionsOf(sent);
  // The kind is sent only on create; an existing entry keeps its own.
  if (entry !== null) input.id = entry.id;
  else input.kind = sent.kind;
  if (sent.apiKey !== '') input.apiKey = sent.apiKey;
  else if (sent.clearKey) input.apiKey = null;
  return input;
}

/**
 * The draft after a save: edits made while the save ran stay; only the key that was sent leaves the field.
 *
 * @param current the draft now
 * @param sent the draft that was sent
 * @param view the saved entry
 * @returns the new draft
 */
export function draftAfterSave(current: ProviderDraft, sent: ProviderDraft, view: ProviderView): ProviderDraft {
  if (current === sent) return draftOf(view);
  return { ...current, apiKey: current.apiKey === sent.apiKey ? '' : current.apiKey, clearKey: false };
}

/**
 * The draft after a kind change: a base URL still at the prefill of the previous kind follows the new kind;
 * a typed one stays.
 *
 * @param current the draft now
 * @param kind the new kind
 * @returns the new draft
 */
export function draftWithKind(current: ProviderDraft, kind: ProviderKind): ProviderDraft {
  const baseUrl = current.baseUrl.trim() === baseUrlOf(current.kind) ? baseUrlOf(kind) : current.baseUrl;
  return { ...current, kind, baseUrl };
}
